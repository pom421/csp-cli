// Recherche (recherches.yaml) → URL de la liste, au format produit par le JS du site :
// /nos-offres/filtres/<segment>/<valeur>/…/page/<n>/  (valeurs multiples jointes par « - »).
import type { Recherche } from '../config.ts';
import { origine } from '../securite/urls.ts';
import { CATEGORIES, DEPARTEMENTS, NATURES, OUI_NON, REGIONS, SEGMENTS, type Segment } from './referentiel.ts';

/** Nombre maximal de pages servies par le site (le lien « dernière page » plafonne à 200). */
export const PAGES_MAX = 200;

function natures(types: Recherche['type_contrat']): string[] {
  if (!types?.length || (types.includes('titulaire') && types.includes('contractuel'))) return [];
  return types.includes('titulaire')
    ? [NATURES.titulaire_ou_contractuel, NATURES.fonctionnaires_seulement]
    : [NATURES.titulaire_ou_contractuel, NATURES.contractuels_seulement];
}

const ouiNon = (v: boolean | undefined) => (v === undefined ? [] : [v ? OUI_NON.oui : OUI_NON.non]);

/**
 * Filtres envoyés au site. Jamais les mots-clés (stratégie 2 : cherchés localement dans le texte) ; `fenetre` : valeur du
 * filtre « date de publication » (`FENETRES_PUBLICATION`), absente pour la liste complète.
 */
export function segmentsRecherche(r: Recherche, fenetre?: string): Partial<Record<Segment, string[]>> {
  const loc = r.localisation;
  return {
    localisation: [
      ...(loc?.regions ?? []).map((nom) => REGIONS[nom]),
      ...(loc?.departements ?? []).map((code) => DEPARTEMENTS[code]),
    ],
    categorie: (r.categories ?? []).map((c) => CATEGORIES[c]),
    type: natures(r.type_contrat),
    management: ouiNon(r.management),
    teletravail: ouiNon(r.teletravail),
    'date-de-publication': fenetre ? [fenetre] : [],
  };
}

export function urlRecherche(r: Recherche, page = 1, fenetre?: string): URL {
  if (!Number.isInteger(page) || page < 1 || page > PAGES_MAX) throw new RangeError(`Page hors limites : ${page}`);
  const segments = segmentsRecherche(r, fenetre);
  let chemin = '/nos-offres/';
  const filtres = SEGMENTS.filter((s) => segments[s]?.length).map(
    (s) => `${s}/${segments[s]!.map((v) => encodeURIComponent(v)).join('-')}/`,
  );
  if (filtres.length) chemin += `filtres/${filtres.join('')}`;
  if (page > 1) chemin += `page/${page}/`;
  return new URL(chemin, origine('site'));
}
