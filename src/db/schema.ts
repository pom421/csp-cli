// Schéma de la base (PLAN §10). Chaque migration est appliquée une seule fois, dans l'ordre (PRAGMA user_version).
// Ne jamais modifier une migration publiée : en ajouter une nouvelle.

export const MIGRATIONS: readonly string[] = [
  // 1 — schéma initial
  `
  CREATE TABLE offres (
    id_offre                  TEXT PRIMARY KEY,
    url                       TEXT NOT NULL,
    titre                     TEXT NOT NULL,
    employeur                 TEXT,
    versant                   TEXT CHECK (versant IN ('FPE', 'FPT', 'FPH')),
    categorie                 TEXT CHECK (categorie IN ('A+', 'A', 'B', 'C')),
    type_contrat              TEXT CHECK (type_contrat IN ('titulaire', 'contractuel', 'titulaire_ou_contractuel')),
    duree_contrat_mois        INTEGER CHECK (duree_contrat_mois > 0),
    temps_travail             TEXT CHECK (temps_travail IN ('complet', 'partiel')),
    metier                    TEXT,
    domaine                   TEXT,
    adresse                   TEXT,
    commune                   TEXT,
    code_postal               TEXT,
    departement               TEXT,
    latitude                  REAL CHECK (latitude BETWEEN -90 AND 90),
    longitude                 REAL CHECK (longitude BETWEEN -180 AND 180),
    precision_geo             TEXT CHECK (precision_geo IN ('adresse', 'commune')),
    teletravail_jours_semaine REAL CHECK (teletravail_jours_semaine BETWEEN 0 AND 5),
    remuneration_min          INTEGER CHECK (remuneration_min >= 0),
    remuneration_max          INTEGER CHECK (remuneration_max >= 0),
    remuneration_texte        TEXT,
    management                INTEGER CHECK (management IN (0, 1)),
    taille_equipe             INTEGER CHECK (taille_equipe >= 0),
    experience_annees_min     INTEGER CHECK (experience_annees_min >= 0),
    niveau_diplome            TEXT,
    competences               TEXT CHECK (competences IS NULL OR json_valid(competences)),
    date_publication          TEXT,
    date_limite_candidature   TEXT,
    date_prise_poste          TEXT,
    resume                    TEXT,
    points_attention          TEXT CHECK (points_attention IS NULL OR json_valid(points_attention)),
    empreinte_carte           TEXT,
    empreinte_detail          TEXT,
    empreinte_identite        TEXT,
    statut                    TEXT NOT NULL DEFAULT 'active' CHECK (statut IN ('active', 'cloturee', 'expiree')),
    absences_consecutives     INTEGER NOT NULL DEFAULT 0 CHECK (absences_consecutives >= 0),
    republication_de          TEXT REFERENCES offres (id_offre) ON DELETE SET NULL,
    date_premiere_vue         TEXT NOT NULL,
    date_derniere_vue         TEXT NOT NULL,
    date_maj_detail           TEXT,
    date_resume               TEXT
  ) STRICT;

  -- Détection des republications : même titre + employeur + commune sous un nouvel identifiant.
  CREATE INDEX offres_empreinte_identite ON offres (empreinte_identite);
  CREATE INDEX offres_statut ON offres (statut);

  CREATE TABLE recherches_offres (
    nom_recherche TEXT NOT NULL,
    id_offre      TEXT NOT NULL REFERENCES offres (id_offre) ON DELETE CASCADE,
    PRIMARY KEY (nom_recherche, id_offre)
  ) STRICT;

  CREATE TABLE a_resumer (
    id_offre    TEXT PRIMARY KEY REFERENCES offres (id_offre) ON DELETE CASCADE,
    raison      TEXT NOT NULL CHECK (raison IN ('nouvelle', 'modifiee')),
    chemin_brut TEXT NOT NULL,
    date        TEXT NOT NULL
  ) STRICT;

  CREATE TABLE geocodage_cache (
    cle_lieu      TEXT PRIMARY KEY,
    latitude      REAL NOT NULL CHECK (latitude BETWEEN -90 AND 90),
    longitude     REAL NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    precision_geo TEXT NOT NULL CHECK (precision_geo IN ('adresse', 'commune')),
    source        TEXT NOT NULL,
    date          TEXT NOT NULL
  ) STRICT;

  -- cle_origine = empreinte de l'adresse de départ : l'adresse elle-même n'est jamais en base.
  CREATE TABLE trajets_cache (
    cle_origine        TEXT NOT NULL,
    cle_destination    TEXT NOT NULL,
    heure_ref          TEXT NOT NULL,
    duree_min          INTEGER CHECK (duree_min >= 0),
    nb_correspondances INTEGER CHECK (nb_correspondances >= 0),
    date               TEXT NOT NULL,
    PRIMARY KEY (cle_origine, cle_destination, heure_ref)
  ) STRICT;

  CREATE TABLE executions (
    id           INTEGER PRIMARY KEY,
    debut        TEXT NOT NULL,
    fin          TEXT,
    statut       TEXT NOT NULL DEFAULT 'en_cours' CHECK (statut IN ('en_cours', 'complete', 'incomplete', 'echec')),
    code_sortie  INTEGER,
    nb_cartes    INTEGER,
    nb_nouvelles INTEGER,
    nb_modifiees INTEGER,
    nb_expirees  INTEGER,
    message      TEXT
  ) STRICT;
  `,
];

export type Versant = 'FPE' | 'FPT' | 'FPH';
export type Categorie = 'A+' | 'A' | 'B' | 'C';
export type TypeContrat = 'titulaire' | 'contractuel' | 'titulaire_ou_contractuel';
export type Statut = 'active' | 'cloturee' | 'expiree';
export type PrecisionGeo = 'adresse' | 'commune';

/** Champs posés par le code (carte, page détail, géocodage). */
export interface ChampsCode {
  id_offre: string;
  url: string;
  titre: string;
  employeur: string | null;
  versant: Versant | null;
  categorie: Categorie | null;
  type_contrat: TypeContrat | null;
  temps_travail: 'complet' | 'partiel' | null;
  metier: string | null;
  domaine: string | null;
  adresse: string | null;
  commune: string | null;
  code_postal: string | null;
  departement: string | null;
  latitude: number | null;
  longitude: number | null;
  precision_geo: PrecisionGeo | null;
  date_publication: string | null;
  date_limite_candidature: string | null;
  empreinte_carte: string | null;
  empreinte_detail: string | null;
  empreinte_identite: string | null;
}

/** Champs écrits par Claude à partir du texte libre (validés par zod en phase 6). */
export interface ChampsResume {
  resume: string;
  points_attention: string[];
  competences: string[];
  type_contrat?: TypeContrat | null;
  duree_contrat_mois: number | null;
  temps_travail?: 'complet' | 'partiel' | null;
  teletravail_jours_semaine: number | null;
  remuneration_min: number | null;
  remuneration_max: number | null;
  remuneration_texte: string | null;
  management: boolean | null;
  taille_equipe: number | null;
  experience_annees_min: number | null;
  niveau_diplome: string | null;
  date_prise_poste: string | null;
}

/** Ligne complète de la table `offres`, JSON décodé et booléens restitués. */
export interface Offre extends ChampsCode, Omit<ChampsResume, 'resume' | 'points_attention' | 'competences'> {
  type_contrat: TypeContrat | null;
  temps_travail: 'complet' | 'partiel' | null;
  resume: string | null;
  points_attention: string[] | null;
  competences: string[] | null;
  statut: Statut;
  absences_consecutives: number;
  republication_de: string | null;
  date_premiere_vue: string;
  date_derniere_vue: string;
  date_maj_detail: string | null;
  date_resume: string | null;
}

export interface Execution {
  id: number;
  debut: string;
  fin: string | null;
  statut: 'en_cours' | 'complete' | 'incomplete' | 'echec';
  code_sortie: number | null;
  nb_cartes: number | null;
  nb_nouvelles: number | null;
  nb_modifiees: number | null;
  nb_expirees: number | null;
  message: string | null;
}
