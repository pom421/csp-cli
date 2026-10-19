// Recherche (recherches.yaml) → URL de la liste, au format produit par le JS du site :
// /nos-offres/filtres/<segment>/<valeur>/…/page/<n>/  (valeurs multiples jointes par « - »).
import type { Recherche } from '../config.ts';
import { origine } from '../securite/urls.ts';
import {
  CATEGORIES,
  DEPARTEMENTS,
  EXPERIENCES,
  INTERRUPTEUR,
  NATURES,
  REGIONS,
  SEGMENTS,
  type Segment,
} from './referentiel.ts';

/** Nombre maximal de pages servies par le site (le lien « dernière page » plafonne à 200). */
export const PAGES_MAX = 200;

function natures(types: Recherche['type_contrat']): string[] {
  if (!types?.length || (types.includes('titulaire') && types.includes('contractuel'))) return [];
  return types.includes('titulaire')
    ? [NATURES.titulaire_ou_contractuel, NATURES.fonctionnaires_seulement]
    : [NATURES.titulaire_ou_contractuel, NATURES.contractuels_seulement];
}

export function segmentsRecherche(r: Recherche): Partial<Record<Segment, string[]>> {
  const loc = r.localisation;
  return {
    // Le site remplace « / » par « --- » dans le mot-clé ; les mots-clés de la config sont joints par une espace.
    'mot-cles': r.mots_cles.length ? [r.mots_cles.join(' ').replaceAll('/', '---')] : [],
    localisation: [
      ...(loc?.regions ?? []).map((nom) => REGIONS[nom]),
      ...(loc?.departements ?? []).map((code) => DEPARTEMENTS[code]),
    ],
    categorie: (r.categories ?? []).map((c) => CATEGORIES[c]),
    type: natures(r.type_contrat),
    management: r.management ? [INTERRUPTEUR] : [],
    teletravail: r.teletravail ? [INTERRUPTEUR] : [],
    experience: r.experience ? [EXPERIENCES[r.experience]] : [],
  };
}

export function urlRecherche(r: Recherche, page = 1): URL {
  if (!Number.isInteger(page) || page < 1 || page > PAGES_MAX) throw new RangeError(`Page hors limites : ${page}`);
  const segments = segmentsRecherche(r);
  let chemin = '/nos-offres/';
  const filtres = SEGMENTS.filter((s) => segments[s]?.length).map(
    (s) => `${s}/${segments[s]!.map((v) => encodeURIComponent(v)).join('-')}/`,
  );
  if (filtres.length) chemin += `filtres/${filtres.join('')}`;
  if (page > 1) chemin += `page/${page}/`;
  return new URL(chemin, origine('site'));
}
