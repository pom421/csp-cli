// Lieu d'une offre → requêtes de géocodage, de la plus précise à la plus grossière (fonctions pures).
// Le texte « Localisation » du site est libre : adresse complète, « 5 AVENUE BUFFON 45064 ORLEANS CEDEX 2 »,
// service + adresse, commune seule, « Loiret (45), France »… Relevé sur les offres réelles (PLAN §7).
import type { PrecisionGeo } from '../db/schema.ts';
import { cleComparaison, normaliserTexte } from '../scraper/normalisation.ts';

export interface Lieu {
  adresse: string | null;
  code_postal: string | null;
  commune: string | null;
  departement: string | null;
}

/**
 * `adresse` : voie et numéro. `mairie` : la mairie de la commune, point plus représentatif que le centre
 * géométrique (souvent loin de tout arrêt de transport). `commune` : centre de la commune, en dernier recours.
 */
export type Mode = 'adresse' | 'mairie' | 'commune';

export interface Requete {
  q: string;
  mode: Mode;
}

export const precisionDe = (mode: Mode): PrecisionGeo => (mode === 'adresse' ? 'adresse' : 'commune');

/** Retire ce qui gêne le géocodeur : CEDEX, « (45) », « (41000) », « , France ». */
export function nettoyer(texte: string): string {
  return normaliserTexte(
    texte
      .replace(/\bcedex(\s*\d+)?\b/gi, ' ')
      .replace(/\((\d{2,3}|2[AB]|\d{5})\)/gi, ' ')
      .replace(/,\s*france\s*$/i, ' '),
  ).replace(/[\s,-]+$/, '');
}

/**
 * Partie adresse d'un lieu : les segments séparés par « - » à partir du premier qui commence par un numéro
 * (« DDETSPP - PÔLE ADM - 31 Mail Charlot - 41000 BLOIS » → « 31 Mail Charlot 41000 BLOIS »).
 */
export function partieAdresse(adresse: string): string {
  const segments = adresse.split(/\s+-\s+/);
  // « Avenue Buffon - 45100 ORLEANS » : le segment « code postal + commune » ne marque pas le début de l'adresse.
  const debut = segments.findIndex((s) => /^\d/.test(s.trim()) && !/^\d{5}\b/.test(s.trim()));
  return nettoyer((debut > 0 ? segments.slice(debut) : segments).join(' '));
}

/** Nom de commune probable quand la page n'a pas de code postal : dernier segment, sans département ni CEDEX. */
export function communeProbable(lieu: Lieu): string | null {
  if (lieu.commune) return nettoyer(lieu.commune) || null;
  if (!lieu.adresse) return null;
  const dernier = nettoyer(lieu.adresse.split(/\s+-\s+/).at(-1) ?? '');
  const apresCodePostal = /\b\d{5}\s+(\D.*)$/.exec(dernier)?.[1];
  if (apresCodePostal) return apresCodePostal;
  // Un reste chiffré (« 5 AVENUE BUFFON 45064 ») n'est pas un nom de commune.
  return dernier && !/\d/.test(dernier) ? dernier : null;
}

/** « Université d'Orléans », « Tribunal administratif de Blois » → « Orléans », « Blois ». */
export function communeApresPreposition(texte: string): string | null {
  // Préfixe glouton : la dernière préposition l'emporte (« Rectorat de l'académie de Nice » → « Nice »).
  const m = /^.*\b(?:d'|d’|de la |de |du )\s*([^,()\d\s-][^,()\d]*?)\s*$/i.exec(nettoyer(texte));
  return m ? m[1] : null;
}

/** Requêtes à essayer dans l'ordre ; la première qui donne un résultat fiable l'emporte. */
export function requetesLieu(lieu: Lieu): Requete[] {
  const requetes: Requete[] = [];
  if (lieu.adresse) {
    const adresse = partieAdresse(lieu.adresse);
    // Adresse = voie suivie d'un code postal ; « 45000 ORLEANS » seul ne vaut pas mieux que la commune.
    if (/\S.*\b\d{5}\b/.test(adresse) && !/^\d{5}\b/.test(adresse)) requetes.push({ q: adresse, mode: 'adresse' });
  }
  const communes = [communeProbable(lieu), lieu.adresse && communeApresPreposition(lieu.adresse)];
  for (const commune of communes) {
    if (commune) requetes.push({ q: commune, mode: 'mairie' }, { q: commune, mode: 'commune' });
  }
  const vues = new Set<string>();
  return requetes.filter((r) => {
    const cle = `${r.mode}:${cleComparaison(r.q)}`;
    if (!cleComparaison(r.q) || vues.has(cle)) return false;
    vues.add(cle);
    return true;
  });
}

/** Clé du cache : deux offres au même lieu (même texte, même département) → un seul géocodage. */
export const cleLieu = (lieu: Lieu): string =>
  [lieu.adresse, lieu.code_postal, lieu.commune, lieu.departement].map((p) => cleComparaison(p ?? '')).join('|');

/** Distance à vol d'oiseau en kilomètres (formule de haversine). */
export function distanceKm(a: Point, b: Point): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export interface Point {
  latitude: number;
  longitude: number;
}
