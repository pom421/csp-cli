// Données servies par `csp web` à l'application (web/) : types seuls, partagés des deux côtés.
// Ni empreintes, ni compteurs internes, ni chemin de texte brut : seulement ce qui s'affiche.

export type Versant = 'FPE' | 'FPT' | 'FPH';
export type Categorie = 'A+' | 'A' | 'B' | 'C';
export type TypeContrat = 'titulaire' | 'contractuel' | 'titulaire_ou_contractuel';
export type TempsTravail = 'complet' | 'partiel';
export type StatutOffre = 'active' | 'cloturee' | 'expiree';

export interface TrajetWeb {
  duree_min: number;
  nb_correspondances: number;
}

export interface OffreWeb {
  id_offre: string;
  /** Lien vers l'offre sur le site, vérifié par le serveur ; `null` s'il sort de l'origine du site. */
  url: string | null;
  titre: string;
  employeur: string | null;
  versant: Versant | null;
  categorie: Categorie | null;
  type_contrat: TypeContrat | null;
  duree_contrat_mois: number | null;
  temps_travail: TempsTravail | null;
  metier: string | null;
  domaine: string | null;
  commune: string | null;
  code_postal: string | null;
  departement: string | null;
  teletravail_possible: boolean | null;
  teletravail_jours_semaine: number | null;
  remuneration_min: number | null;
  remuneration_max: number | null;
  remuneration_texte: string | null;
  management: boolean | null;
  taille_equipe: number | null;
  experience_annees_min: number | null;
  niveau_diplome: string | null;
  competences: string[];
  points_attention: string[];
  /** Markdown simple (puces « - ») écrit par un modèle : à afficher comme du texte, jamais comme du HTML. */
  resume: string | null;
  date_publication: string | null;
  date_limite_candidature: string | null;
  date_prise_poste: string | null;
  date_premiere_vue: string;
  date_derniere_vue: string;
  date_maj_detail: string | null;
  statut: StatutOffre;
  republication: boolean;
  recherches: string[];
  /**
   * Trajet depuis le point de départ de chaque recherche de l'offre, par nom de recherche : absent si non calculé,
   * `null` si aucun itinéraire.
   */
  trajets: Record<string, TrajetWeb | null>;
}

export interface RechercheWeb {
  nom: string;
  /** Texte de `depart` dans recherches.yaml ; `null` : pas de trajets pour cette recherche. */
  depart: string | null;
}

export interface DerniereCollecte {
  debut: string;
  fin: string | null;
  statut: 'en_cours' | 'complete' | 'incomplete' | 'echec';
  nb_nouvelles: number | null;
  nb_modifiees: number | null;
  nb_expirees: number | null;
}

export interface ReponseOffres {
  /** Jour de Paris (AAAA-MM-JJ) : référence des « nouvelles » et des dates limites. */
  aujourdhui: string;
  derniere_collecte: DerniereCollecte | null;
  recherches: RechercheWeb[];
  /** Message lisible si recherches.yaml manque ou est invalide (les trajets ne sont alors pas affichés). */
  avertissement: string | null;
  offres: OffreWeb[];
}
