// Normalisation des textes et empreintes : deux jours de suite, une offre inchangée doit donner la même empreinte.
import { createHash } from 'node:crypto';

/**
 * Espaces (dont insécables et retours à la ligne) réduits à une seule espace, Unicode en forme NFC.
 * Les caractères de contrôle et de format sont retirés : un texte du site affiché au terminal ne peut pas y injecter
 * de séquence d'échappement.
 */
export function normaliserTexte(texte: string): string {
  return texte
    .normalize('NFC')
    .replace(new RegExp('[\\s\\u00a0\\u202f\\u200b]+', 'g'), ' ')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .trim();
}

/** Clé de comparaison : minuscules, sans accents ni ponctuation (republications, lieux). */
export function cleComparaison(texte: string): string {
  return normaliserTexte(texte)
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** SHA-256 hexadécimal des parties normalisées ; `null` et texte vide ne se confondent pas. */
export function empreinte(...parties: (string | null | undefined)[]): string {
  const normalisees = parties.map((p) => (p == null ? null : normaliserTexte(p)));
  return createHash('sha256').update(JSON.stringify(normalisees)).digest('hex');
}

/** Identité d'une offre indépendante de son identifiant : détecte les republications. */
export const empreinteIdentite = (titre: string, employeur: string | null, commune: string | null) =>
  empreinte(cleComparaison(titre), employeur && cleComparaison(employeur), commune && cleComparaison(commune));

const MOIS = [
  'janvier',
  'fevrier',
  'mars',
  'avril',
  'mai',
  'juin',
  'juillet',
  'aout',
  'septembre',
  'octobre',
  'novembre',
  'decembre',
];

/** « 19 », « octobre », « 2026 » → « 2026-10-19 » ; `null` si la date n'existe pas. */
export function dateFrancaise(jour: string, mois: string, annee: string): string | null {
  const m = MOIS.indexOf(cleComparaison(mois)) + 1;
  const j = Number(jour);
  const a = Number(annee);
  if (!m || !Number.isInteger(j) || !Number.isInteger(a)) return null;
  const d = new Date(Date.UTC(a, m - 1, j));
  if (d.getUTCDate() !== j || d.getUTCMonth() !== m - 1) return null;
  return d.toISOString().slice(0, 10);
}

/** « 16/11/2026 » → « 2026-11-16 » ; `null` si invalide. */
export function dateNumerique(texte: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(texte.trim());
  if (!m) return null;
  const [, j, mo, a] = m;
  return dateFrancaise(j, MOIS[Number(mo) - 1] ?? '', a);
}
