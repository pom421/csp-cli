// Schéma de la base (PLAN §10), source unique : `pnpm db:generer` en tire les migrations SQL (dossier drizzle/).
// Les noms de colonnes sont les clés des objets (snake_case français).
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';

export const VERSANTS = ['FPE', 'FPT', 'FPH'] as const;
export const CATEGORIES = ['A+', 'A', 'B', 'C'] as const;
export const TYPES_CONTRAT = ['titulaire', 'contractuel', 'titulaire_ou_contractuel'] as const;
export const TEMPS_TRAVAIL = ['complet', 'partiel'] as const;
export const PRECISIONS_GEO = ['adresse', 'commune'] as const;
export const STATUTS = ['active', 'cloturee', 'expiree'] as const;
export const RAISONS = ['nouvelle', 'modifiee'] as const;
export const STATUTS_EXECUTION = ['en_cours', 'complete', 'incomplete', 'echec'] as const;

/** Contrainte CHECK « valeur dans la liste » : la base refuse ce que le typage TypeScript n'aurait pas vu. */
const dans = (colonne: AnySQLiteColumn, valeurs: readonly string[]) =>
  sql`${colonne} IN (${sql.join(
    valeurs.map((v) => sql.raw(`'${v}'`)),
    sql`, `,
  )})`;

export const offres = sqliteTable(
  'offres',
  {
    id_offre: text().primaryKey(),
    url: text().notNull(),
    titre: text().notNull(),
    employeur: text(),
    versant: text({ enum: VERSANTS }),
    categorie: text({ enum: CATEGORIES }),
    type_contrat: text({ enum: TYPES_CONTRAT }),
    duree_contrat_mois: integer(),
    temps_travail: text({ enum: TEMPS_TRAVAIL }),
    metier: text(),
    domaine: text(),
    adresse: text(),
    commune: text(),
    code_postal: text(),
    departement: text(),
    latitude: real(),
    longitude: real(),
    precision_geo: text({ enum: PRECISIONS_GEO }),
    /** Case « Télétravail possible » de la page (code) ; le nombre de jours vient du résumé. */
    teletravail_possible: integer({ mode: 'boolean' }),
    teletravail_jours_semaine: real(),
    remuneration_min: integer(),
    remuneration_max: integer(),
    remuneration_texte: text(),
    management: integer({ mode: 'boolean' }),
    taille_equipe: integer(),
    experience_annees_min: integer(),
    niveau_diplome: text(),
    competences: text({ mode: 'json' }).$type<string[]>(),
    date_publication: text(),
    date_limite_candidature: text(),
    date_prise_poste: text(),
    resume: text(),
    points_attention: text({ mode: 'json' }).$type<string[]>(),
    empreinte_carte: text(),
    empreinte_detail: text(),
    /** Titre + employeur + commune : détecte une offre republiée sous un nouvel identifiant. */
    empreinte_identite: text(),
    statut: text({ enum: STATUTS }).notNull().default('active'),
    absences_consecutives: integer().notNull().default(0),
    republication_de: text().references((): AnySQLiteColumn => offres.id_offre, { onDelete: 'set null' }),
    date_premiere_vue: text().notNull(),
    date_derniere_vue: text().notNull(),
    date_maj_detail: text(),
    date_resume: text(),
  },
  (t) => [
    index('offres_empreinte_identite').on(t.empreinte_identite),
    index('offres_statut').on(t.statut),
    check('offres_versant', dans(t.versant, VERSANTS)),
    check('offres_categorie', dans(t.categorie, CATEGORIES)),
    check('offres_type_contrat', dans(t.type_contrat, TYPES_CONTRAT)),
    check('offres_temps_travail', dans(t.temps_travail, TEMPS_TRAVAIL)),
    check('offres_precision_geo', dans(t.precision_geo, PRECISIONS_GEO)),
    check('offres_statut', dans(t.statut, STATUTS)),
    check('offres_duree_contrat', sql`${t.duree_contrat_mois} > 0`),
    check('offres_latitude', sql`${t.latitude} BETWEEN -90 AND 90`),
    check('offres_longitude', sql`${t.longitude} BETWEEN -180 AND 180`),
    check('offres_teletravail', sql`${t.teletravail_jours_semaine} BETWEEN 0 AND 5`),
    check('offres_remuneration', sql`${t.remuneration_min} >= 0 AND ${t.remuneration_max} >= 0`),
    check('offres_management', sql`${t.management} IN (0, 1)`),
    check('offres_teletravail_possible', sql`${t.teletravail_possible} IN (0, 1)`),
    check('offres_effectifs', sql`${t.taille_equipe} >= 0 AND ${t.experience_annees_min} >= 0`),
    check('offres_json', sql`json_valid(${t.competences}) AND json_valid(${t.points_attention})`),
    check('offres_absences', sql`${t.absences_consecutives} >= 0`),
  ],
);

export const recherches_offres = sqliteTable(
  'recherches_offres',
  {
    nom_recherche: text().notNull(),
    id_offre: text()
      .notNull()
      .references(() => offres.id_offre, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.nom_recherche, t.id_offre] })],
);

export const a_resumer = sqliteTable(
  'a_resumer',
  {
    id_offre: text()
      .primaryKey()
      .references(() => offres.id_offre, { onDelete: 'cascade' }),
    raison: text({ enum: RAISONS }).notNull(),
    chemin_brut: text().notNull(),
    date: text().notNull(),
  },
  (t) => [check('a_resumer_raison', dans(t.raison, RAISONS))],
);

export const geocodage_cache = sqliteTable(
  'geocodage_cache',
  {
    cle_lieu: text().primaryKey(),
    latitude: real().notNull(),
    longitude: real().notNull(),
    precision_geo: text({ enum: PRECISIONS_GEO }).notNull(),
    source: text().notNull(),
    date: text().notNull(),
  },
  (t) => [
    check('geocodage_latitude', sql`${t.latitude} BETWEEN -90 AND 90`),
    check('geocodage_longitude', sql`${t.longitude} BETWEEN -180 AND 180`),
    check('geocodage_precision', dans(t.precision_geo, PRECISIONS_GEO)),
  ],
);

/** `cle_origine` = empreinte de l'adresse de départ : l'adresse elle-même n'est jamais en base. */
export const trajets_cache = sqliteTable(
  'trajets_cache',
  {
    cle_origine: text().notNull(),
    cle_destination: text().notNull(),
    heure_ref: text().notNull(),
    /** null = aucun itinéraire (mis en cache aussi, pour ne pas redemander chaque jour). */
    duree_min: integer(),
    nb_correspondances: integer(),
    date: text().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.cle_origine, t.cle_destination, t.heure_ref] }),
    check('trajets_positifs', sql`${t.duree_min} >= 0 AND ${t.nb_correspondances} >= 0`),
  ],
);

export const executions = sqliteTable(
  'executions',
  {
    id: integer().primaryKey(),
    debut: text().notNull(),
    fin: text(),
    statut: text({ enum: STATUTS_EXECUTION }).notNull().default('en_cours'),
    code_sortie: integer(),
    nb_cartes: integer(),
    nb_nouvelles: integer(),
    nb_modifiees: integer(),
    nb_expirees: integer(),
    message: text(),
  },
  (t) => [check('executions_statut', dans(t.statut, STATUTS_EXECUTION))],
);

export type Offre = typeof offres.$inferSelect;
export type Execution = typeof executions.$inferSelect;
export type Geocodage = typeof geocodage_cache.$inferSelect;
export type Trajet = typeof trajets_cache.$inferSelect;
export type PrecisionGeo = (typeof PRECISIONS_GEO)[number];
export type Statut = (typeof STATUTS)[number];

/** Champs posés par le code (carte, page détail, géocodage). */
export type ChampsCode = Pick<
  Offre,
  | 'id_offre'
  | 'url'
  | 'titre'
  | 'employeur'
  | 'versant'
  | 'categorie'
  | 'type_contrat'
  | 'temps_travail'
  | 'metier'
  | 'domaine'
  | 'adresse'
  | 'commune'
  | 'code_postal'
  | 'departement'
  | 'latitude'
  | 'longitude'
  | 'precision_geo'
  | 'management'
  | 'teletravail_possible'
  | 'date_publication'
  | 'date_limite_candidature'
  | 'date_prise_poste'
  | 'empreinte_carte'
  | 'empreinte_detail'
  | 'empreinte_identite'
>;

/**
 * Champs écrits par Claude à partir du texte libre (validés par zod en phase 6). Les champs optionnels ne
 * complètent que ce que le code n'a pas trouvé sur la page (PLAN §10 « code, sinon LLM »).
 */
export type ChampsResume = Pick<
  Offre,
  | 'duree_contrat_mois'
  | 'teletravail_jours_semaine'
  | 'remuneration_min'
  | 'remuneration_max'
  | 'remuneration_texte'
  | 'taille_equipe'
  | 'experience_annees_min'
  | 'niveau_diplome'
> & {
  resume: string;
  points_attention: string[];
  competences: string[];
  type_contrat?: Offre['type_contrat'];
  temps_travail?: Offre['temps_travail'];
  management?: Offre['management'];
  date_prise_poste?: Offre['date_prise_poste'];
};
