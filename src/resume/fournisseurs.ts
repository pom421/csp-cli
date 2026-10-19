// Fournisseurs de résumés interchangeables, choisis par CSP_LLM_FOURNISSEUR :
// - anthropic : Claude, par le SDK officiel (sortie structurée `output_config.format`) ;
// - albert : API Albert (Etalab), compatible OpenAI (`/v1/chat/completions`, `response_format` json_schema).
// Chacun renvoie le texte JSON proposé par le modèle ; la validation (zod) est commune (src/resume/resumer.ts).
import Anthropic from '@anthropic-ai/sdk';
import { BlocageError, IndisponibleError, UserError } from '../erreurs.ts';
import { envoyerJson, obtenir } from '../http.ts';
import { origine } from '../securite/urls.ts';
import { CONSIGNE_SYSTEME, messageOffre } from './consigne.ts';
import { SCHEMA_JSON } from './schema.ts';

/** Échec sur une offre (refus, réponse tronquée, JSON invalide) : on passe à la suivante. */
export class ErreurResume extends Error {}

export interface Relance {
  /** Erreurs de validation de la réponse précédente, renvoyées au modèle pour correction. */
  erreurs: string[];
}

export interface FournisseurResume {
  readonly nom: 'anthropic' | 'albert';
  readonly modele: string;
  /** Texte JSON proposé par le modèle pour cette offre (non encore validé). */
  proposer(texteBrut: string, relance?: Relance): Promise<string>;
  /** Vérifie clé et modèle (csp doctor) ; renvoie une description courte. */
  verifier(): Promise<string>;
}

const MAX_TOKENS = 16_000;

function messageUtilisateur(texteBrut: string, relance?: Relance): string {
  const base = messageOffre(texteBrut);
  if (!relance) return base;
  return `${base}\n\nUne première réponse a été refusée par la validation pour ces raisons :\n${relance.erreurs
    .map((e) => `- ${e}`)
    .join('\n')}\nRéponds de nouveau en corrigeant ces points.`;
}

// ── Claude (Anthropic) ──────────────────────────────────────────────────────

export const MODELE_ANTHROPIC_DEFAUT = 'claude-opus-5-5';

/** Modèles qui acceptent le repli côté serveur `fallbacks: "default"` en cas de refus. */
const MODELES_AVEC_REPLI = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const EFFORTS = new Set<string>(['low', 'medium', 'high', 'xhigh', 'max']);

export class FournisseurAnthropic implements FournisseurResume {
  readonly nom = 'anthropic';
  readonly modele: string;
  private readonly effort: Effort | undefined;
  private readonly client: Anthropic;

  constructor(modele: string, cle: string | undefined, effort?: Effort) {
    this.modele = modele;
    this.effort = effort;
    // Sans CSP_LLM_CLE, le SDK cherche lui-même ses identifiants (ANTHROPIC_API_KEY, profil `ant auth login`).
    this.client = new Anthropic({ apiKey: cle, baseURL: origine('anthropic'), maxRetries: 2, timeout: 120_000 });
  }

  async proposer(texteBrut: string, relance?: Relance): Promise<string> {
    const repli = MODELES_AVEC_REPLI.has(this.modele);
    let reponse: Anthropic.Beta.BetaMessage;
    try {
      reponse = await this.client.beta.messages.create({
        model: this.modele,
        max_tokens: MAX_TOKENS,
        // Consigne identique à chaque appel : mise en cache (sans effet si elle est sous le seuil du modèle).
        system: [{ type: 'text', text: CONSIGNE_SYSTEME, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: messageUtilisateur(texteBrut, relance) }],
        output_config: {
          format: { type: 'json_schema', schema: SCHEMA_JSON },
          ...(this.effort ? { effort: this.effort } : {}),
        },
        // Refus d'un classifieur de sécurité : la requête est rejouée sur un modèle de repli choisi par l'API.
        ...(repli ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      });
    } catch (e) {
      throw erreurAnthropic(e);
    }
    if (reponse.stop_reason === 'refusal') {
      throw new ErreurResume(`refus du modèle (${reponse.stop_details?.category ?? 'catégorie inconnue'})`);
    }
    if (reponse.stop_reason === 'max_tokens') throw new ErreurResume('réponse tronquée (max_tokens)');
    const texte = reponse.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    if (!texte) throw new ErreurResume('réponse sans texte');
    return texte;
  }

  async verifier(): Promise<string> {
    try {
      const m = await this.client.models.retrieve(this.modele);
      return `Claude, ${m.display_name} (${m.id})`;
    } catch (e) {
      throw erreurAnthropic(e);
    }
  }
}

/** Erreurs du SDK → familles du projet : configuration (code 1) ou indisponibilité (code 3, retenter plus tard). */
function erreurAnthropic(e: unknown): Error {
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
    return new UserError(`Clé Anthropic refusée (${e.status}) : vérifiez CSP_LLM_CLE ou ANTHROPIC_API_KEY.`);
  }
  if (e instanceof Anthropic.NotFoundError) return new UserError(`Modèle introuvable : ${e.message}`);
  if (e instanceof Anthropic.BadRequestError)
    return new UserError(`Requête refusée par l'API Anthropic : ${e.message}`);
  if (e instanceof Anthropic.RateLimitError || e instanceof Anthropic.InternalServerError) {
    return new IndisponibleError(`API Anthropic indisponible (${e.status}) : ${e.message}`);
  }
  if (e instanceof Anthropic.APIConnectionError)
    return new IndisponibleError(`API Anthropic injoignable : ${e.message}`);
  if (e instanceof Anthropic.APIError) return new UserError(`API Anthropic, erreur ${e.status} : ${e.message}`);
  return e instanceof Error ? e : new Error(String(e));
}

// ── Albert (Etalab, compatible OpenAI) ──────────────────────────────────────

interface ReponseChat {
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
}

const attendre = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class FournisseurAlbert implements FournisseurResume {
  readonly nom = 'albert';
  /** Passe à `json_object` (schéma dans la consigne) si le modèle refuse `json_schema`. */
  private formatSimple = false;
  readonly modele: string;
  private readonly cle: string;
  private readonly pauseMs: number;

  constructor(modele: string, cle: string, pauseMs = 2_000) {
    this.modele = modele;
    this.cle = cle;
    this.pauseMs = pauseMs;
  }

  private get entetes() {
    return { authorization: `Bearer ${this.cle}` };
  }

  async proposer(texteBrut: string, relance?: Relance): Promise<string> {
    for (let essai = 0; ; essai++) {
      const systeme = this.formatSimple
        ? `${CONSIGNE_SYSTEME}\n\nL'objet JSON suit exactement ce schéma (tous les champs présents) :\n${JSON.stringify(SCHEMA_JSON)}`
        : CONSIGNE_SYSTEME;
      const r = await envoyerJson(
        new URL('/v1/chat/completions', origine('albert')),
        {
          model: this.modele,
          messages: [
            { role: 'system', content: systeme },
            { role: 'user', content: messageUtilisateur(texteBrut, relance) },
          ],
          response_format: this.formatSimple
            ? { type: 'json_object' }
            : { type: 'json_schema', json_schema: { name: 'resume_offre', strict: true, schema: SCHEMA_JSON } },
          temperature: 0.2,
          max_tokens: 4_000,
          stream: false,
        },
        this.entetes,
      );
      if (r.statut === 200) {
        let corps: ReponseChat;
        try {
          corps = JSON.parse(r.texte) as ReponseChat;
        } catch {
          throw new ErreurResume('réponse Albert illisible');
        }
        const choix = corps.choices?.[0];
        if (choix?.finish_reason === 'length') throw new ErreurResume('réponse tronquée (max_tokens)');
        const texte = choix?.message?.content;
        if (!texte) throw new ErreurResume('réponse sans texte');
        return texte;
      }
      if (r.statut === 401 || r.statut === 403)
        throw new UserError(`Clé Albert refusée (${r.statut}) : vérifiez CSP_LLM_CLE.`);
      if (r.statut === 404) throw new UserError(`Albert : modèle ou adresse introuvable (${this.modele}).`);
      if (
        (r.statut === 400 || r.statut === 422) &&
        !this.formatSimple &&
        /response_format|json_schema|guided/i.test(r.texte)
      ) {
        this.formatSimple = true;
        continue;
      }
      if ((r.statut === 429 || r.statut >= 500) && essai < 2) {
        await attendre(this.pauseMs * (essai + 1));
        continue;
      }
      if (r.statut === 429 || r.statut >= 500)
        throw new IndisponibleError(`API Albert indisponible (HTTP ${r.statut})`);
      throw new UserError(`API Albert, erreur ${r.statut} : ${r.texte.slice(0, 300)}`);
    }
  }

  async verifier(): Promise<string> {
    let r;
    try {
      r = await obtenir(new URL('/v1/models', origine('albert')), 'application/json', this.entetes);
    } catch (e) {
      if (e instanceof BlocageError) throw new UserError('Clé Albert refusée : vérifiez CSP_LLM_CLE.');
      throw e;
    }
    if (r.statut === 401) throw new UserError('Clé Albert refusée : vérifiez CSP_LLM_CLE.');
    if (r.statut !== 200) throw new UserError(`Albert /v1/models : HTTP ${r.statut}`);
    const modeles = (JSON.parse(r.texte) as { data?: { id: string; type?: string }[] }).data ?? [];
    const texte = modeles.filter((m) => !m.type || m.type === 'text-generation').map((m) => m.id);
    if (!texte.includes(this.modele)) {
      throw new UserError(
        `Modèle Albert « ${this.modele} » absent. Modèles de génération de texte : ${texte.join(', ')}`,
      );
    }
    return `Albert, ${this.modele}`;
  }
}

// ── Choix du fournisseur ────────────────────────────────────────────────────

/** Fournisseur décrit par le .env : CSP_LLM_FOURNISSEUR, CSP_LLM_MODELE, CSP_LLM_CLE, CSP_LLM_EFFORT (Claude). */
export function fournisseurDepuisEnv(env: NodeJS.ProcessEnv = process.env): FournisseurResume {
  const nom = env.CSP_LLM_FOURNISSEUR || 'anthropic';
  const cle = env.CSP_LLM_CLE || undefined;
  if (nom === 'anthropic') {
    const effort = env.CSP_LLM_EFFORT;
    if (effort && !EFFORTS.has(effort)) throw new UserError(`CSP_LLM_EFFORT invalide : ${effort} (low…max)`);
    return new FournisseurAnthropic(env.CSP_LLM_MODELE || MODELE_ANTHROPIC_DEFAUT, cle, effort as Effort | undefined);
  }
  if (nom === 'albert') {
    if (!cle) throw new UserError('CSP_LLM_CLE (clé Albert) manquante dans le .env.');
    if (!env.CSP_LLM_MODELE) {
      throw new UserError(
        'CSP_LLM_MODELE manquant : choisissez un modèle Albert de génération de texte (csp doctor les liste).',
      );
    }
    return new FournisseurAlbert(env.CSP_LLM_MODELE, cle);
  }
  throw new UserError(`CSP_LLM_FOURNISSEUR inconnu : ${nom} (anthropic ou albert)`);
}
