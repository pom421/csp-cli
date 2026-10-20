// Mise en forme des valeurs pour l'affichage (dates, rémunérations, trajets, libellés).
import type { OffreWeb, StatutOffre, TrajetWeb, TypeContrat } from '../../../src/web/contrat.ts';

const DATE = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const DATE_COURTE = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** « 2026-10-20 » → « 20 oct. 2026 » ; la date seule, sans fuseau (UTC, pour ne pas glisser d'un jour). */
export function date(iso: string | null, courte = false): string | null {
  if (!iso) return null;
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : (courte ? DATE_COURTE : DATE).format(d);
}

const EUROS = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });

/** Brut annuel en k€ : « 38–45 k€ », « dès 38 k€ », « jusqu'à 45 k€ » ; `null` si inconnu. */
export function remuneration(o: Pick<OffreWeb, 'remuneration_min' | 'remuneration_max'>): string | null {
  const k = (n: number) => EUROS.format(Math.round(n / 1000));
  const { remuneration_min: min, remuneration_max: max } = o;
  if (min !== null && max !== null) return min === max ? `${k(min)} k€` : `${k(min)}–${k(max)} k€`;
  if (min !== null) return `dès ${k(min)} k€`;
  if (max !== null) return `jusqu’à ${k(max)} k€`;
  return null;
}

/** « 45 min », « 1 h 20 » ; « 2 corresp. » en option. */
export function duree(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${String(m).padStart(2, '0')}` : `${h} h`;
}

export function trajet(t: TrajetWeb | null | undefined, avecCorrespondances = false): string {
  if (t === undefined) return 'trajet non calculé';
  if (t === null) return 'aucun itinéraire';
  if (!avecCorrespondances) return duree(t.duree_min);
  const c = t.nb_correspondances;
  return `${duree(t.duree_min)} · ${c === 0 ? 'direct' : `${c} correspondance${c > 1 ? 's' : ''}`}`;
}

export const LIBELLES_CONTRAT: Record<TypeContrat, string> = {
  titulaire: 'Titulaire',
  contractuel: 'Contractuel',
  titulaire_ou_contractuel: 'Titulaire ou contractuel',
};

export const LIBELLES_STATUT: Record<StatutOffre, string> = {
  active: 'Active',
  cloturee: 'Clôturée',
  expiree: 'Retirée du site',
};

export const LIBELLES_VERSANT = {
  FPE: 'État',
  FPT: 'Territoriale',
  FPH: 'Hospitalière',
} as const;

/** « Orléans (45) », « Loiret (45) », ou ce qui est connu. */
export function lieu(o: Pick<OffreWeb, 'commune' | 'departement'>): string | null {
  if (o.commune && o.departement) return `${o.commune} (${o.departement})`;
  return o.commune ?? (o.departement ? `Département ${o.departement}` : null);
}

export function teletravail(o: Pick<OffreWeb, 'teletravail_possible' | 'teletravail_jours_semaine'>): string | null {
  const j = o.teletravail_jours_semaine;
  if (j !== null && j > 0) return `Télétravail ${String(j).replace('.', ',')} j/sem.`;
  if (o.teletravail_possible) return 'Télétravail possible';
  return null;
}

export const pluriel = (n: number, mot: string, pluriel = `${mot}s`) => `${n} ${n > 1 ? pluriel : mot}`;
