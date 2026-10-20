// Filtres et tri des offres, côté navigateur (quelques centaines d'offres : tout tient en mémoire).
// Fonctions pures, testées dans filtres.test.ts ; l'état des filtres est aussi rangé dans l'URL (lien à garder).
import type { Categorie, OffreWeb, StatutOffre, TempsTravail, TrajetWeb, Versant } from '../../../src/web/contrat.ts';

export const VERSANTS: Versant[] = ['FPE', 'FPT', 'FPH'];
export const CATEGORIES: Categorie[] = ['A+', 'A', 'B', 'C'];
export const STATUTS: StatutOffre[] = ['active', 'cloturee', 'expiree'];
export const CONTRATS = ['titulaire', 'contractuel'] as const;
export const PERIODES = ['tout', '1', '7', '30'] as const;
export const TRIS = ['recentes', 'trajet', 'remuneration', 'limite'] as const;

export type Contrat = (typeof CONTRATS)[number];
export type Periode = (typeof PERIODES)[number];
export type Tri = (typeof TRIS)[number];
export type Management = 'tous' | 'oui' | 'non';

export interface Filtres {
  texte: string;
  /** Une recherche de recherches.yaml ; `null` : toutes. Choisit aussi le point de départ des trajets. */
  recherche: string | null;
  statuts: StatutOffre[];
  /** Offres vues pour la première fois depuis N jours. */
  periode: Periode;
  versants: Versant[];
  categories: Categorie[];
  contrats: Contrat[];
  temps: TempsTravail | null;
  teletravail: boolean;
  management: Management;
  departements: string[];
  /** Minutes ; une offre sans trajet connu est écartée dès que ce filtre est posé. */
  trajetMax: number | null;
  /** Euros bruts annuels ; une offre sans rémunération connue est écartée dès que ce filtre est posé. */
  remunerationMin: number | null;
  tri: Tri;
}

export const FILTRES_PAR_DEFAUT: Filtres = {
  texte: '',
  recherche: null,
  statuts: ['active'],
  periode: 'tout',
  versants: [],
  categories: [],
  contrats: [],
  temps: null,
  teletravail: false,
  management: 'tous',
  departements: [],
  trajetMax: null,
  remunerationMin: null,
  tri: 'recentes',
};

// ── Recherche plein texte ───────────────────────────────────────────────────

/** Minuscules sans accents : « Développeur » est trouvé par « developpeur ». */
export const sansAccents = (t: string) =>
  t
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

function texteDe(o: OffreWeb): string {
  return sansAccents(
    [
      o.titre,
      o.employeur,
      o.metier,
      o.domaine,
      o.commune,
      o.departement,
      o.niveau_diplome,
      o.resume,
      ...o.competences,
      ...o.points_attention,
    ]
      .filter(Boolean)
      .join(' \n '),
  );
}

// ── Trajet, dates ───────────────────────────────────────────────────────────

/**
 * Trajet affiché : depuis le départ de la recherche choisie, sinon le plus court des départs de l'offre.
 * `undefined` : non calculé ; `null` : aucun itinéraire.
 */
export function trajetDe(o: OffreWeb, recherche: string | null): TrajetWeb | null | undefined {
  if (recherche !== null) return o.trajets[recherche];
  const connus = Object.values(o.trajets);
  if (!connus.length) return undefined;
  const avecItineraire = connus.filter((t): t is TrajetWeb => t !== null);
  if (!avecItineraire.length) return null;
  return avecItineraire.reduce((a, b) => (b.duree_min < a.duree_min ? b : a));
}

/** Jours entre deux dates AAAA-MM-JJ (positif si `b` est après `a`). */
export const ecartJours = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

/** Nouvelle : vue pour la première fois il y a moins de 2 jours. */
export const estNouvelle = (o: OffreWeb, aujourdhui: string) => ecartJours(o.date_premiere_vue, aujourdhui) < 2;

/** Modifiée : détail changé après la première lecture, dans la dernière semaine. */
export const estModifiee = (o: OffreWeb, aujourdhui: string) =>
  o.date_maj_detail !== null &&
  o.date_maj_detail > o.date_premiere_vue &&
  ecartJours(o.date_maj_detail, aujourdhui) < 7;

/** Date limite dans moins de 7 jours (et pas passée). */
export function limiteProche(o: OffreWeb, aujourdhui: string): boolean {
  if (!o.date_limite_candidature) return false;
  const reste = ecartJours(aujourdhui, o.date_limite_candidature);
  return reste >= 0 && reste < 7;
}

// ── Filtrage ────────────────────────────────────────────────────────────────

const contratCorrespond = (o: OffreWeb, contrats: Contrat[]) =>
  !contrats.length ||
  (o.type_contrat !== null && (o.type_contrat === 'titulaire_ou_contractuel' || contrats.includes(o.type_contrat)));

/** Rémunération connue la plus haute de la fourchette. */
const remunerationHaute = (o: OffreWeb) => o.remuneration_max ?? o.remuneration_min;

export function filtrer(offres: OffreWeb[], f: Filtres, aujourdhui: string): OffreWeb[] {
  const mots = sansAccents(f.texte).split(/\s+/).filter(Boolean);
  return offres.filter((o) => {
    if (f.statuts.length && !f.statuts.includes(o.statut)) return false;
    if (f.recherche !== null && !o.recherches.includes(f.recherche)) return false;
    if (f.periode !== 'tout' && ecartJours(o.date_premiere_vue, aujourdhui) >= Number(f.periode)) return false;
    if (f.versants.length && (o.versant === null || !f.versants.includes(o.versant))) return false;
    if (f.categories.length && (o.categorie === null || !f.categories.includes(o.categorie))) return false;
    if (!contratCorrespond(o, f.contrats)) return false;
    if (f.temps !== null && o.temps_travail !== f.temps) return false;
    if (f.teletravail && !(o.teletravail_possible || (o.teletravail_jours_semaine ?? 0) > 0)) return false;
    if (f.management !== 'tous' && o.management !== (f.management === 'oui')) return false;
    if (f.departements.length && (o.departement === null || !f.departements.includes(o.departement))) return false;
    if (f.trajetMax !== null) {
      const t = trajetDe(o, f.recherche);
      if (!t || t.duree_min > f.trajetMax) return false;
    }
    if (f.remunerationMin !== null) {
      const r = remunerationHaute(o);
      if (r === null || r < f.remunerationMin) return false;
    }
    if (mots.length) {
      const t = texteDe(o);
      if (!mots.every((m) => t.includes(m))) return false;
    }
    return true;
  });
}

// ── Tri ─────────────────────────────────────────────────────────────────────

/** Les valeurs inconnues vont toujours en fin de liste, quel que soit le tri. */
const parValeur = <T>(valeur: (o: OffreWeb) => T | null | undefined, ordre: 1 | -1) => {
  return (a: OffreWeb, b: OffreWeb) => {
    const va = valeur(a);
    const vb = valeur(b);
    if (va == null || vb == null) return va == null ? (vb == null ? 0 : 1) : -1;
    return va < vb ? -ordre : va > vb ? ordre : 0;
  };
};

export function trier(offres: OffreWeb[], tri: Tri, recherche: string | null): OffreWeb[] {
  const recentes = (a: OffreWeb, b: OffreWeb) =>
    b.date_premiere_vue.localeCompare(a.date_premiere_vue) ||
    (b.date_publication ?? '').localeCompare(a.date_publication ?? '') ||
    a.id_offre.localeCompare(b.id_offre);
  const cle = {
    recentes: () => 0,
    trajet: parValeur((o) => trajetDe(o, recherche)?.duree_min, 1),
    remuneration: parValeur(remunerationHaute, -1),
    limite: parValeur((o) => o.date_limite_candidature, 1),
  }[tri];
  return [...offres].sort((a, b) => cle(a, b) || recentes(a, b));
}

// ── Filtres ↔ URL ───────────────────────────────────────────────────────────

const liste = <T extends string>(brut: string | null, permis: readonly T[]): T[] =>
  (brut ?? '').split(',').filter((v): v is T => (permis as readonly string[]).includes(v));

const un = <T extends string>(brut: string | null, permis: readonly T[], defaut: T): T =>
  (permis as readonly string[]).includes(brut ?? '') ? (brut as T) : defaut;

function entier(brut: string | null): number | null {
  const n = Number(brut);
  return brut !== null && Number.isInteger(n) && n > 0 ? n : null;
}

/** Paramètres d'URL → filtres ; toute valeur inconnue est ignorée (lien ancien ou modifié à la main). */
export function depuisUrl(p: URLSearchParams): Filtres {
  return {
    texte: p.get('q') ?? '',
    recherche: p.get('recherche') || null,
    statuts: p.has('statuts') ? liste(p.get('statuts'), STATUTS) : FILTRES_PAR_DEFAUT.statuts,
    periode: un(p.get('periode'), PERIODES, 'tout'),
    versants: liste(p.get('versants'), VERSANTS),
    categories: liste(p.get('categories'), CATEGORIES),
    contrats: liste(p.get('contrats'), CONTRATS),
    temps: p.get('temps') === 'complet' || p.get('temps') === 'partiel' ? (p.get('temps') as TempsTravail) : null,
    teletravail: p.get('teletravail') === '1',
    management: un(p.get('management'), ['tous', 'oui', 'non'] as const, 'tous'),
    departements: (p.get('departements') ?? '').split(',').filter((d) => /^(\d{2,3}|2[AB])$/.test(d)),
    trajetMax: entier(p.get('trajet')),
    remunerationMin: entier(p.get('remuneration')),
    tri: un(p.get('tri'), TRIS, 'recentes'),
  };
}

/** Filtres → paramètres d'URL ; seules les valeurs différentes du défaut y figurent. */
export function versUrl(f: Filtres): URLSearchParams {
  const p = new URLSearchParams();
  const d = FILTRES_PAR_DEFAUT;
  if (f.texte.trim()) p.set('q', f.texte.trim());
  if (f.recherche) p.set('recherche', f.recherche);
  if (f.statuts.join() !== d.statuts.join()) p.set('statuts', f.statuts.join(','));
  if (f.periode !== d.periode) p.set('periode', f.periode);
  if (f.versants.length) p.set('versants', f.versants.join(','));
  if (f.categories.length) p.set('categories', f.categories.join(','));
  if (f.contrats.length) p.set('contrats', f.contrats.join(','));
  if (f.temps) p.set('temps', f.temps);
  if (f.teletravail) p.set('teletravail', '1');
  if (f.management !== d.management) p.set('management', f.management);
  if (f.departements.length) p.set('departements', f.departements.join(','));
  if (f.trajetMax !== null) p.set('trajet', String(f.trajetMax));
  if (f.remunerationMin !== null) p.set('remuneration', String(f.remunerationMin));
  if (f.tri !== d.tri) p.set('tri', f.tri);
  return p;
}

/** Nombre de filtres posés (hors texte et tri), pour le badge du bouton « Filtres ». */
export function nombreFiltres(f: Filtres): number {
  const d = FILTRES_PAR_DEFAUT;
  return [
    f.recherche !== null,
    f.statuts.join() !== d.statuts.join(),
    f.periode !== d.periode,
    f.versants.length > 0,
    f.categories.length > 0,
    f.contrats.length > 0,
    f.temps !== null,
    f.teletravail,
    f.management !== d.management,
    f.departements.length > 0,
    f.trajetMax !== null,
    f.remunerationMin !== null,
  ].filter(Boolean).length;
}
