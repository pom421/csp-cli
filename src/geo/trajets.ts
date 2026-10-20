// Temps de trajet en transports en commun depuis l'adresse de départ (PLAN §7), avec cache en base.
// L'adresse de départ est une donnée personnelle : seule son empreinte va en base (`cle_origine`), jamais le texte
// ni les coordonnées. Le cache est donc propre à chaque origine et ne touche pas la table des offres.
import type { Depot } from '../db/depot.ts';
import type { Offre } from '../db/schema.ts';
import { BlocageError, IndisponibleError, UserError } from '../erreurs.ts';
import { cleComparaison, empreinte } from '../scraper/normalisation.ts';
import type { SourceGeocodage } from './geocodage.ts';
import type { Point } from './lieux.ts';

export interface ResultatTrajet {
  duree_min: number;
  nb_correspondances: number;
}

/** Calcul d'itinéraire (Transitous aujourd'hui ; Navitia ou autre branchable sans toucher au reste). */
export interface FournisseurTrajet {
  nom: string;
  /** `null` : aucun itinéraire en transports en commun. */
  calculer(depart: Point, arrivee: Point, quand: Date): Promise<ResultatTrajet | null>;
}

export interface Origine {
  /** Empreinte de l'adresse : clé du cache, seule trace de l'origine en base. */
  cle: string;
  point: Point;
}

// ── Date de référence ───────────────────────────────────────────────────────

/** Jours fériés à date fixe (les fériés mobiles tombent un lundi, un jeudi ou un dimanche, jamais un mardi). */
const FERIES_FIXES = ['01-01', '05-01', '05-08', '07-14', '08-15', '11-01', '11-11', '12-25'];
const MARDI = 2;

/** Jour du trajet de référence : le prochain mardi non férié après `jour` (AAAA-MM-JJ). */
export function jourReference(jour: string): string {
  const d = new Date(`${jour}T12:00:00Z`);
  do d.setUTCDate(d.getUTCDate() + ((MARDI - d.getUTCDay() + 7) % 7 || 7));
  while (FERIES_FIXES.includes(d.toISOString().slice(5, 10)));
  return d.toISOString().slice(0, 10);
}

/** Instant correspondant à `jour` à `heure` (HH:MM), heure de Paris, été comme hiver. */
export function instantParis(jour: string, heure: string): Date {
  const naif = new Date(`${jour}T${heure}:00Z`);
  const decalage = new Intl.DateTimeFormat('en', { timeZone: 'Europe/Paris', timeZoneName: 'longOffset' })
    .formatToParts(naif)
    .find((p) => p.type === 'timeZoneName')!
    .value.replace('GMT', '');
  return new Date(`${jour}T${heure}:00${decalage || '+00:00'}`);
}

/** Clé de l'heure de référence dans le cache : le trajet d'un mardi à 8 h vaut pour tous les mardis à 8 h. */
export const heureRef = (heure: string) => `mardi ${heure}`;

/** Un trajet en cache est recalculé au-delà de cette durée (changements d'horaires, de lignes). */
export const VALIDITE_JOURS = 90;

const ageJours = (depuis: string, jour: string) => (Date.parse(jour) - Date.parse(depuis)) / 86_400_000;

/** Arrondi aux 5 minutes (PLAN §7) ; jamais 0 pour un vrai trajet. */
export const arrondir5 = (minutes: number) => Math.max(5, Math.round(minutes / 5) * 5);

// ── Origine ─────────────────────────────────────────────────────────────────

const COORDONNEES = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

/**
 * Adresse de départ (CSP_ORIGINE_TRAJET) : « lat,lon » ou une adresse, géocodée à chaque exécution et gardée
 * en mémoire seulement. `undefined` si la variable est vide (pas de trajets).
 */
export async function origineTrajet(
  source: SourceGeocodage,
  texte = process.env.CSP_ORIGINE_TRAJET,
): Promise<Origine | undefined> {
  if (!texte?.trim()) return undefined;
  const cle = empreinte('origine', cleComparaison(texte));
  const m = COORDONNEES.exec(texte);
  if (m) {
    const point = { latitude: Number(m[1]), longitude: Number(m[2]) };
    if (Math.abs(point.latitude) > 90 || Math.abs(point.longitude) > 180) {
      throw new UserError('CSP_ORIGINE_TRAJET : coordonnées hors bornes');
    }
    return { cle, point };
  }
  const candidats = await source.chercher(texte, 'adresse');
  const retenu = candidats.find((c) => c.score >= 0.5);
  // Le texte de l'adresse n'apparaît pas dans le message : il peut finir dans un journal.
  if (!retenu) throw new UserError('CSP_ORIGINE_TRAJET : adresse introuvable par le géocodeur, la préciser');
  return { cle, point: { latitude: retenu.latitude, longitude: retenu.longitude } };
}

// ── Calcul avec cache ───────────────────────────────────────────────────────

/** Clé de la destination : coordonnées à ~10 m près, partagées par les offres du même lieu. */
export const cleDestination = (p: Point) => `${p.latitude.toFixed(4)},${p.longitude.toFixed(4)}`;

export type IssueTrajet = 'en_cache' | 'calcule' | 'sans_itineraire';

export interface BilanTrajets {
  fournisseur: string;
  calcules: number;
  en_cache: number;
  sans_itineraire: number;
  /** Offres actives sans coordonnées (lieu introuvable ou géocodage en panne). */
  non_localisees: number;
  /** Message de la panne du fournisseur ; les trajets restants seront calculés au prochain passage. */
  panne: string | null;
}

export interface ContexteTrajets {
  depot: Depot;
  fournisseur: FournisseurTrajet;
  origine: Origine;
  /** Jour de l'exécution (AAAA-MM-JJ, Paris). */
  jour: string;
  /** HH:MM */
  heure: string;
}

/** Trajet vers un point, depuis le cache s'il est encore valide. */
export async function trajetVers(ctx: ContexteTrajets, destination: Point): Promise<IssueTrajet> {
  const cle = cleDestination(destination);
  const ref = heureRef(ctx.heure);
  const cache = ctx.depot.lireTrajet(ctx.origine.cle, cle, ref);
  if (cache && ageJours(cache.date, ctx.jour) < VALIDITE_JOURS) return 'en_cache';
  const quand = instantParis(jourReference(ctx.jour), ctx.heure);
  const r = await ctx.fournisseur.calculer(ctx.origine.point, destination, quand);
  ctx.depot.ecrireTrajet({
    cle_origine: ctx.origine.cle,
    cle_destination: cle,
    heure_ref: ref,
    duree_min: r?.duree_min ?? null,
    nb_correspondances: r?.nb_correspondances ?? null,
    date: ctx.jour,
  });
  return r ? 'calcule' : 'sans_itineraire';
}

const BILAN_VIDE = { calcules: 0, en_cache: 0, sans_itineraire: 0, non_localisees: 0, panne: null };

/** Réducteur : compte l'issue de chaque offre. */
const compter = (b: BilanTrajets, issue: IssueTrajet | 'non_localisee'): BilanTrajets => {
  switch (issue) {
    case 'calcule':
      return { ...b, calcules: b.calcules + 1 };
    case 'en_cache':
      return { ...b, en_cache: b.en_cache + 1 };
    case 'sans_itineraire':
      return { ...b, sans_itineraire: b.sans_itineraire + 1 };
    case 'non_localisee':
      return { ...b, non_localisees: b.non_localisees + 1 };
  }
};

/**
 * Trajets des offres données. Séquentiel (débit maîtrisé côté Transitous, service bénévole) ; une panne du
 * fournisseur arrête les calculs sans faire échouer l'appelant : le reste sera fait au prochain passage.
 */
export async function calculerTrajets(ctx: ContexteTrajets, offres: Offre[]): Promise<BilanTrajets> {
  const issues: (IssueTrajet | 'non_localisee')[] = [];
  let panne: string | null = null;
  for (const o of offres) {
    if (o.latitude === null || o.longitude === null) {
      issues.push('non_localisee');
      continue;
    }
    try {
      issues.push(await trajetVers(ctx, { latitude: o.latitude, longitude: o.longitude }));
    } catch (e) {
      if (!(e instanceof IndisponibleError || e instanceof BlocageError)) throw e;
      panne = e.message;
      break;
    }
  }
  return { ...issues.reduce(compter, { fournisseur: ctx.fournisseur.nom, ...BILAN_VIDE }), panne };
}

/** Trajet en cache d'une offre (rapport, affichage) ; `undefined` si non calculé, durée nulle si aucun itinéraire. */
export function trajetEnCache(
  depot: Depot,
  origine: Pick<Origine, 'cle'>,
  offre: Pick<Offre, 'latitude' | 'longitude'>,
  heure: string,
): ResultatTrajet | null | undefined {
  if (offre.latitude === null || offre.longitude === null) return undefined;
  const t = depot.lireTrajet(
    origine.cle,
    cleDestination({ latitude: offre.latitude, longitude: offre.longitude }),
    heureRef(heure),
  );
  if (!t) return undefined;
  return t.duree_min === null || t.nb_correspondances === null
    ? null
    : { duree_min: t.duree_min, nb_correspondances: t.nb_correspondances };
}
