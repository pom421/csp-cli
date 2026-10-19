// Sélecteurs CSS et libellés du site : le seul endroit à corriger quand la structure change (PLAN §6).
// Structure relevée le 19/10/2026 (docs/reconnaissance.md) ; fixtures dans src/test/fixtures/.

export const LISTE = {
  /** Une vignette d'offre dans les résultats. */
  carte: 'div.fr-card.fr-card--offer',
  /** Lien vers l'offre, texte = titre. */
  lienTitre: 'h3 a[href*="/offre-emploi/"]',
  /** Domaine (étiquette DSFR). */
  domaine: 'ul.fr-tags-group p.fr-tag',
  /** Lignes descriptives, identifiées par leur texte caché « Libellé : ». */
  lignes: 'ul.fr-card__desc li',
  libelleCache: 'span.sr-only',
  /** Titre du bloc de résultats : « <span class="number">N</span> offres d'emploi trouvées » ou « Aucun résultat… ». */
  compteur: '.actions p[role="heading"]',
  compteurNombre: 'span.number',
  pageSuivante: 'a.fr-pagination__link--next[href]',
} as const;

/** Libellés des lignes de la carte (texte du `span.sr-only`, sans les deux-points). */
export const LIBELLES_CARTE = {
  localisation: 'Localisation',
  versant: 'Fonction publique',
  employeur: 'Employeur',
} as const;

/** Texte du compteur quand la recherche ne renvoie rien. */
export const AUCUN_RESULTAT = /aucun résultat ne correspond/i;

/** Ligne de date de la carte : « En ligne depuis le 19 octobre 2026 ». */
export const DATE_EN_LIGNE = /en ligne depuis le\s+(\d{1,2})(?:er)?\s+([a-zéû]+)\s+(\d{4})/i;

/** Fin d'URL d'une offre : la référence, identifiant stable (le slug du titre peut changer). */
export const REFERENCE_URL = /-reference-([A-Za-z0-9][A-Za-z0-9_-]*)\/?$/;

/** « Loiret (45) », « Corse du Sud (2A) », « Guadeloupe (971) ». */
export const DEPARTEMENT_LOCALISATION = /^(.*?)\s*\((\d{2,3}|2[AB])\)$/i;

export const DETAIL = {
  reference: 'p.number',
  titre: 'h1',
  /** Données structurées schema.org JobPosting. */
  jsonLd: 'script[type="application/ld+json"]',
  employeur: 'li.ic--user',
  lieu: 'li.ic--pin',
  /** Tableau « Nature de l'emploi », « Catégorie »… : `<strong>Libellé</strong>` puis valeur. */
  cellules: 'ul.table > li.table-cell',
  libelleCellule: 'strong',
  /** Texte libre : missions, profil recherché, compétences. */
  texteLibre: 'div.col-left.rte',
  /** Accordéons de « À propos de l'offre » : libellé dans le bouton, contenu dans le volet. */
  accordeons: 'section.fr-accordion',
  libelleAccordeon: '.fr-accordion__btn',
  contenuAccordeon: '.fr-collapse',
} as const;

export const LIBELLES_DETAIL = {
  nature: 'Nature de l’emploi',
  experience: 'Expérience souhaitée',
  remuneration: 'Rémunération',
  categorie: 'Catégorie',
  management: 'Management',
  teletravail: 'Télétravail possible',
  statutPoste: 'Statut du poste',
  metier: 'Métier de référence',
} as const;

/** Accordéons recopiés dans le texte brut à résumer (le reste : présentation générique de l'employeur). */
export const ACCORDEONS_UTILES = [
  'Informations complémentaires',
  'Conditions particulières d’exercice',
  'Fondement juridique',
  'Statut du poste',
  'Métier de référence',
];

export const DATE_LIMITE = /date limite de candidature\s*:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i;
export const VACANCE = /(\d{1,2}\/\d{1,2}\/\d{4})/;
export const NON_RENSEIGNE = /^non renseignée?$/i;
