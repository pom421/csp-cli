// Fournisseurs de résumés, par le AI SDK (Vercel) : une seule implémentation, un `LanguageModel` par fournisseur.
// - anthropic : Claude (`@ai-sdk/anthropic`), sortie structurée native, repli serveur en cas de refus ;
// - albert : API Albert d'Etalab, compatible OpenAI (`@ai-sdk/openai-compatible`), `response_format` json_schema.
// Le fournisseur renvoie l'objet proposé par le modèle ; la validation (zod) et la relance sont dans resumer.ts.
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  APICallError,
  generateText,
  jsonSchema,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  Output,
  RetryError,
  type LanguageModel,
} from 'ai';
import { BlocageError, IndisponibleError, UserError } from '../erreurs.ts';
import { fetchListeBlanche, obtenir } from '../http.ts';
import { origine } from '../securite/urls.ts';
import { CONSIGNE_SYSTEME, messageOffre } from './consigne.ts';
import { SCHEMA_JSON } from './schema.ts';

/** Échec sur une offre (refus, réponse tronquée) : on passe à la suivante. */
export class ErreurResume extends Error {}

/** Réponse qui n'est pas un objet JSON : renvoyée au modèle comme une erreur de validation. */
export class ReponseNonJson extends ErreurResume {}

export interface Relance {
  /** Erreurs de validation de la réponse précédente, renvoyées au modèle pour correction. */
  erreurs: string[];
}

export type NomFournisseur = 'anthropic' | 'albert';

export interface FournisseurResume {
  readonly nom: NomFournisseur;
  readonly modele: string;
  /** Objet proposé par le modèle pour cette offre (JSON analysé, non encore validé). */
  proposer(texteBrut: string, relance?: Relance): Promise<unknown>;
  /** Vérifie clé et modèle (csp doctor) ; renvoie une description courte. */
  verifier(): Promise<string>;
}

export const MODELE_ANTHROPIC_DEFAUT = 'claude-opus-5-5';
/** Modèles qui acceptent le repli côté serveur `fallbacks: "default"` en cas de refus. */
const MODELES_AVEC_REPLI = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type Effort = (typeof EFFORTS)[number];

const MAX_TOKENS = 16_000;
const VERSION_API_ANTHROPIC = '2023-06-01';

export function messageUtilisateur(texteBrut: string, relance?: Relance): string {
  const base = messageOffre(texteBrut);
  if (!relance) return base;
  const erreurs = relance.erreurs.map((e) => `- ${e}`).join('\n');
  return `${base}\n\nUne première réponse a été refusée par la validation pour ces raisons :\n${erreurs}\nRéponds de nouveau en corrigeant ces points.`;
}

/** Consigne complétée du schéma, pour un modèle qui n'accepte pas la sortie structurée (`json_object` seul). */
const consigneAvecSchema = () =>
  `${CONSIGNE_SYSTEME}\n\nL'objet JSON suit exactement ce schéma (tous les champs présents) :\n${JSON.stringify(SCHEMA_JSON)}`;

/** Erreurs du AI SDK → familles du projet : configuration (code 1), indisponibilité (code 3) ou échec de l'offre. */
export function traduireErreur(e: unknown, nom: NomFournisseur): Error {
  const appel = RetryError.isInstance(e) ? e.lastError : e;
  if (NoObjectGeneratedError.isInstance(appel)) {
    if (appel.finishReason === 'content-filter') return new ErreurResume('refus du modèle (filtre de sécurité)');
    if (appel.finishReason === 'length') return new ErreurResume('réponse tronquée (max_tokens)');
    return new ReponseNonJson('la réponse n’est pas un objet JSON valide');
  }
  if (NoOutputGeneratedError.isInstance(appel)) return new ReponseNonJson('réponse vide');
  if (APICallError.isInstance(appel)) {
    const statut = appel.statusCode;
    if (statut === 401 || statut === 403)
      return new UserError(`Clé ${nom} refusée (${statut}) : vérifiez CSP_LLM_CLE.`);
    if (statut === 404) return new UserError(`${nom} : modèle ou adresse introuvable (${appel.message}).`);
    if (statut === 429 || (statut ?? 500) >= 500) {
      return new IndisponibleError(`API ${nom} indisponible (${statut ?? 'réseau'}) : ${appel.message}`);
    }
    return new UserError(`API ${nom}, erreur ${statut} : ${appel.message}`);
  }
  return e instanceof Error ? e : new Error(String(e));
}

interface Configuration {
  nom: NomFournisseur;
  modele: string;
  /** Modèle du AI SDK ; `structure` : sortie structurée par schéma (sinon `json_object` + schéma dans la consigne). */
  creerModele(structure: boolean): LanguageModel;
  optionsFournisseur?: Parameters<typeof generateText>[0]['providerOptions'];
  /** Température (Albert) ; les modèles Claude récents n'acceptent pas ce réglage. */
  temperature?: number;
  /** Nouvelles tentatives du AI SDK sur 429/5xx et erreurs réseau (attente exponentielle). */
  tentatives?: number;
  /** Appel en échec à cause du format de sortie : on retente sans sortie structurée. */
  formatRefuse?(e: unknown): boolean;
  verifier(): Promise<string>;
}

/** Implémentation unique : un appel `generateText` avec sortie objet, quel que soit le fournisseur. */
export class FournisseurIA implements FournisseurResume {
  readonly nom: NomFournisseur;
  readonly modele: string;
  private readonly config: Configuration;
  private structure = true;

  constructor(config: Configuration) {
    this.config = config;
    this.nom = config.nom;
    this.modele = config.modele;
  }

  async proposer(texteBrut: string, relance?: Relance): Promise<unknown> {
    try {
      return await this.appeler(texteBrut, relance);
    } catch (e) {
      if (!this.structure || !this.config.formatRefuse?.(e)) throw traduireErreur(e, this.nom);
      this.structure = false;
      return this.proposer(texteBrut, relance);
    }
  }

  private async appeler(texteBrut: string, relance?: Relance): Promise<unknown> {
    const resultat = await generateText({
      model: this.config.creerModele(this.structure),
      instructions: this.structure ? CONSIGNE_SYSTEME : consigneAvecSchema(),
      prompt: messageUtilisateur(texteBrut, relance),
      // Schéma simplifié (types, énumérations) : les bornes sont vérifiées par zod après coup.
      output: Output.object({ schema: jsonSchema<unknown>(SCHEMA_JSON), name: 'resume_offre' }),
      maxOutputTokens: MAX_TOKENS,
      maxRetries: this.config.tentatives ?? 2,
      timeout: 120_000,
      providerOptions: this.config.optionsFournisseur,
      temperature: this.config.temperature,
    });
    // À lire avant `output`, qui lève une erreur quand le modèle n'a rien produit.
    if (resultat.finishReason === 'content-filter') throw new ErreurResume('refus du modèle (filtre de sécurité)');
    return resultat.output;
  }

  verifier(): Promise<string> {
    return this.config.verifier();
  }
}

// ── Claude (Anthropic) ──────────────────────────────────────────────────────

export interface OptionsFournisseur {
  effort?: Effort;
  tentatives?: number;
}

export function fournisseurAnthropic(
  modele: string,
  cle: string | undefined,
  { effort, tentatives }: OptionsFournisseur = {},
): FournisseurIA {
  // Sans CSP_LLM_CLE, le AI SDK lit ANTHROPIC_API_KEY.
  const cleEffective = cle ?? process.env.ANTHROPIC_API_KEY;
  const anthropic = createAnthropic({
    apiKey: cleEffective,
    baseURL: `${origine('anthropic')}/v1`,
    fetch: fetchListeBlanche,
  });
  return new FournisseurIA({
    nom: 'anthropic',
    modele,
    tentatives,
    creerModele: () => anthropic(modele),
    optionsFournisseur: {
      anthropic: {
        structuredOutputMode: 'outputFormat',
        // Consigne identique à chaque appel : mise en cache (sans effet si elle est sous le seuil du modèle).
        cacheControl: { type: 'ephemeral' },
        ...(effort ? { effort } : {}),
        // Refus d'un classifieur de sécurité : la requête est rejouée sur un modèle de repli choisi par l'API.
        ...(MODELES_AVEC_REPLI.has(modele) ? { fallbacks: 'default' } : {}),
      },
    },
    async verifier() {
      if (!cleEffective) throw new UserError('Clé Anthropic absente : CSP_LLM_CLE ou ANTHROPIC_API_KEY.');
      const r = await obtenirApi(
        new URL(`/v1/models/${encodeURIComponent(modele)}`, origine('anthropic')),
        'anthropic',
        {
          'x-api-key': cleEffective,
          'anthropic-version': VERSION_API_ANTHROPIC,
        },
      );
      const m = JSON.parse(r) as { id: string; display_name?: string };
      return `Claude, ${m.display_name ?? m.id} (${m.id})`;
    },
  });
}

// ── Albert (Etalab, compatible OpenAI) ──────────────────────────────────────

export function fournisseurAlbert(modele: string, cle: string, { tentatives }: OptionsFournisseur = {}): FournisseurIA {
  const baseURL = `${origine('albert')}/v1`;
  const albert = (structure: boolean) =>
    createOpenAICompatible({
      name: 'albert',
      baseURL,
      apiKey: cle,
      supportsStructuredOutputs: structure,
      fetch: fetchListeBlanche,
    });
  return new FournisseurIA({
    nom: 'albert',
    modele,
    tentatives,
    creerModele: (structure) => albert(structure).chatModel(modele),
    temperature: 0.2,
    formatRefuse: (e) =>
      APICallError.isInstance(e) &&
      (e.statusCode === 400 || e.statusCode === 422) &&
      /response_format|json_schema|guided/i.test(e.responseBody ?? e.message),
    async verifier() {
      const r = await obtenirApi(new URL('/v1/models', origine('albert')), 'albert', {
        authorization: `Bearer ${cle}`,
      });
      const texte = ((JSON.parse(r) as { data?: { id: string; type?: string }[] }).data ?? [])
        .filter((m) => !m.type || m.type === 'text-generation')
        .map((m) => m.id);
      if (!texte.includes(modele)) {
        throw new UserError(`Modèle Albert « ${modele} » absent. Modèles de génération de texte : ${texte.join(', ')}`);
      }
      return `Albert, ${modele}`;
    },
  });
}

/** GET authentifié sur l'API d'un fournisseur (csp doctor) ; renvoie le corps en cas de succès. */
async function obtenirApi(url: URL, nom: NomFournisseur, entetes: Record<string, string>): Promise<string> {
  let r;
  try {
    r = await obtenir(url, 'application/json', entetes);
  } catch (e) {
    // obtenir() classe 403/429 en blocage du site ; ici, c'est une clé refusée ou un quota.
    if (e instanceof BlocageError) throw new UserError(`Clé ${nom} refusée ou quota atteint : vérifiez CSP_LLM_CLE.`);
    throw e;
  }
  if (r.statut === 401) throw new UserError(`Clé ${nom} refusée : vérifiez CSP_LLM_CLE.`);
  if (r.statut === 404) throw new UserError(`${nom} : modèle introuvable (${url.pathname}).`);
  if (r.statut !== 200) throw new UserError(`${nom} ${url.pathname} : HTTP ${r.statut}`);
  return r.texte;
}

// ── Choix du fournisseur ────────────────────────────────────────────────────

/** Fournisseur décrit par le .env : CSP_LLM_FOURNISSEUR, CSP_LLM_MODELE, CSP_LLM_CLE, CSP_LLM_EFFORT (Claude). */
export function fournisseurDepuisEnv(env: NodeJS.ProcessEnv = process.env): FournisseurResume {
  const nom = env.CSP_LLM_FOURNISSEUR || 'anthropic';
  const cle = env.CSP_LLM_CLE || undefined;
  switch (nom) {
    case 'anthropic': {
      const effort = env.CSP_LLM_EFFORT || undefined;
      if (effort && !(EFFORTS as readonly string[]).includes(effort)) {
        throw new UserError(`CSP_LLM_EFFORT invalide : ${effort} (${EFFORTS.join(', ')})`);
      }
      return fournisseurAnthropic(env.CSP_LLM_MODELE || MODELE_ANTHROPIC_DEFAUT, cle, {
        effort: effort as Effort | undefined,
      });
    }
    case 'albert':
      if (!cle) throw new UserError('CSP_LLM_CLE (clé Albert) manquante dans le .env.');
      if (!env.CSP_LLM_MODELE) {
        throw new UserError(
          'CSP_LLM_MODELE manquant : choisissez un modèle Albert de génération de texte (csp doctor les liste).',
        );
      }
      return fournisseurAlbert(env.CSP_LLM_MODELE, cle);
    default:
      throw new UserError(`CSP_LLM_FOURNISSEUR inconnu : ${nom} (anthropic ou albert)`);
  }
}
