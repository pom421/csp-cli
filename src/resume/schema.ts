// Format du résumé d'une offre (PLAN §10 « Format du résumé »), commun à tous les fournisseurs.
// Le schéma JSON envoyé au modèle n'a que types, énumérations et champs obligatoires (les fournisseurs n'acceptent
// pas tous les bornes) ; les bornes et règles de cohérence sont vérifiées ici, après coup, par zod.
import { z } from 'zod';
import { retirerCoordonnees } from '../scraper/detail.ts';

const DATE_ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Un texte qui contient une coordonnée (e-mail, téléphone) est refusé : rien de tel ne doit aller en base. */
const sansCoordonnees = (t: string) => retirerCoordonnees(t) === t;

const texte = (max: number) =>
  z.string().trim().min(1).max(max).refine(sansCoordonnees, 'contient une coordonnée (e-mail ou téléphone)');

const entier = (min: number, max: number) => z.number().int().min(min).max(max);

export const ResumeSchema = z
  .strictObject({
    resume: texte(1500).describe(
      'Markdown, puces d’une ligne dans cet ordre : « - **Rôle** : … », « - **Stack** : … », « - **IA** : … » (omise sans IA), « - **Conditions** : … ».',
    ),
    points_attention: z
      .array(texte(200))
      .max(6)
      .describe('Contraintes : astreintes, déplacements, habilitation, date limite proche… Liste vide si aucune.'),
    competences: z.array(texte(80)).max(12).describe('Compétences attendues, formulées en quelques mots.'),
    type_contrat: z
      .enum(['titulaire', 'contractuel', 'titulaire_ou_contractuel'])
      .nullable()
      .describe('Public visé ; null si non précisé.'),
    duree_contrat_mois: entier(1, 120)
      .nullable()
      .describe('Durée du contrat en mois si elle est indiquée, sinon null.'),
    temps_travail: z.enum(['complet', 'partiel']).nullable().describe('null si non précisé.'),
    teletravail_jours_semaine: z
      .number()
      .min(0)
      .max(5)
      .multipleOf(0.5)
      .nullable()
      .describe('Jours de télétravail par semaine si un nombre est indiqué, sinon null.'),
    remuneration_min: entier(5_000, 400_000).nullable().describe('Brut annuel en euros (convertir un mensuel × 12).'),
    remuneration_max: entier(5_000, 400_000).nullable().describe('Brut annuel en euros (convertir un mensuel × 12).'),
    remuneration_texte: texte(300).nullable().describe('Formulation de la rémunération telle qu’écrite, sinon null.'),
    management: z.boolean().nullable().describe('Encadrement d’une équipe ; null si non précisé.'),
    taille_equipe: entier(0, 100_000).nullable().describe('Nombre de personnes encadrées si indiqué, sinon null.'),
    experience_annees_min: entier(0, 40).nullable().describe('Années d’expérience minimales si indiquées, sinon null.'),
    niveau_diplome: texte(60).nullable().describe('Par exemple « Bac+3 », « Bac+5 » ; null si non précisé.'),
    date_prise_poste: z
      .string()
      .regex(DATE_ISO)
      .nullable()
      .describe('AAAA-MM-JJ si une date précise est donnée, sinon null.'),
  })
  .refine(
    (r) => r.remuneration_min === null || r.remuneration_max === null || r.remuneration_min <= r.remuneration_max,
    {
      message: 'remuneration_min supérieur à remuneration_max',
      path: ['remuneration_min'],
    },
  );

export type Resume = z.infer<typeof ResumeSchema>;

const MOTS_CLES_RETIRES = new Set([
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minItems',
  'maxItems',
  '$schema',
]);

function simplifier(noeud: unknown): unknown {
  if (Array.isArray(noeud)) return noeud.map(simplifier);
  if (noeud === null || typeof noeud !== 'object') return noeud;
  return Object.fromEntries(
    Object.entries(noeud)
      .filter(([cle]) => !MOTS_CLES_RETIRES.has(cle))
      .map(([cle, valeur]) => [cle, simplifier(valeur)]),
  );
}

/** Schéma JSON du résumé pour la sortie structurée des fournisseurs : tous les champs obligatoires, aucun en plus. */
export const SCHEMA_JSON = simplifier(z.toJSONSchema(ResumeSchema, { target: 'draft-7' })) as Record<string, unknown>;

/** Valide un résumé ; renvoie la liste lisible des erreurs (pour la relance du modèle ou le message utilisateur). */
export function validerResume(brut: unknown): { ok: true; resume: Resume } | { ok: false; erreurs: string[] } {
  const r = ResumeSchema.safeParse(brut);
  if (r.success) return { ok: true, resume: r.data };
  return { ok: false, erreurs: r.error.issues.map((i) => `${i.path.join('.') || '(racine)'} : ${i.message}`) };
}
