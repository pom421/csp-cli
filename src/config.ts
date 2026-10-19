// Emplacements locaux, variables du .env et recherches quotidiennes (recherches.yaml).
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { UserError } from './erreurs.ts';
import { DEPARTEMENTS, REGIONS } from './scraper/referentiel.ts';

/** Données hors du dépôt : le binaire est lancé depuis n'importe quel dossier. */
export function dossierCsp(): string {
  return resolve(process.env.CSP_HOME || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'csp-veille'));
}

export function chemins(home = dossierCsp()) {
  return {
    home,
    env: join(home, '.env'),
    recherches: join(home, 'recherches.yaml'),
    base: join(home, 'csp.sqlite'),
    brut: join(home, 'brut'),
    diagnostics: join(home, 'diagnostics'),
  };
}

/** Charge le .env de l'utilisateur ; les variables déjà définies dans le shell priment. */
export function chargerEnv(fichier = chemins().env): void {
  if (existsSync(fichier)) process.loadEnvFile(fichier);
}

const HEURE_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function heureDepart(): string {
  const v = process.env.CSP_HEURE_DEPART || '08:00';
  if (!HEURE_RE.test(v)) throw new UserError(`CSP_HEURE_DEPART attend HH:MM : ${v}`);
  return v;
}

// Valeurs lisibles ; la correspondance avec les identifiants du site est dans src/scraper/referentiel.ts.
const texte = z.string().trim().min(1).max(200);

export const RechercheSchema = z.strictObject({
  nom: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'minuscules, chiffres et tirets (sert de clé en base et de nom de dossier)'),
  mots_cles: z.array(texte).max(10).default([]),
  localisation: z
    .strictObject({
      // Filtrés par le site :
      departements: z.array(z.enum(Object.keys(DEPARTEMENTS) as [string, ...string[]])).optional(),
      regions: z.array(z.enum(Object.keys(REGIONS) as [string, ...string[]])).optional(),
      // Filtrés localement après géocodage (phase 5) : le filtre géographique du site ne marche pas par URL.
      commune: texte.optional(),
      rayon_km: z.number().positive().max(200).optional(),
    })
    .refine((l) => (l.commune === undefined) === (l.rayon_km === undefined), {
      message: 'commune et rayon_km vont ensemble',
    })
    .optional(),
  teletravail: z.boolean().optional(),
  management: z.boolean().optional(),
  categories: z.array(z.enum(['A+', 'A', 'B', 'C'])).optional(),
  versants: z.array(z.enum(['FPE', 'FPT', 'FPH'])).optional(),
  type_contrat: z.array(z.enum(['titulaire', 'contractuel'])).optional(),
  experience: z.enum(['debutant', 'confirme', 'expert']).optional(),
});

export const RecherchesSchema = z
  .strictObject({ recherches: z.array(RechercheSchema).min(1) })
  .refine((c) => new Set(c.recherches.map((r) => r.nom)).size === c.recherches.length, {
    message: 'deux recherches portent le même nom',
  });

export type Recherche = z.infer<typeof RechercheSchema>;

/** Lit et valide recherches.yaml : une erreur précise plutôt qu'une recherche silencieusement différente. */
export function lireRecherches(fichier = chemins().recherches): Recherche[] {
  if (!existsSync(fichier)) {
    throw new UserError(
      `Fichier de recherches absent : ${fichier}\nCopiez l'exemple : cp config/recherches.example.yaml ${fichier}`,
    );
  }
  let brut: unknown;
  try {
    brut = parse(readFileSync(fichier, 'utf8'));
  } catch (e) {
    throw new UserError(`${fichier} : YAML invalide\n${(e as Error).message}`);
  }
  const res = RecherchesSchema.safeParse(brut);
  if (!res.success) {
    const details = res.error.issues.map((i) => `  - ${i.path.join('.') || '(racine)'} : ${i.message}`).join('\n');
    throw new UserError(`${fichier} : configuration invalide\n${details}`);
  }
  return res.data.recherches;
}
