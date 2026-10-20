// Pages de résultats → cartes (vignettes d'offres), pagination comprise.
import type { Recherche } from '../config.ts';
import { CasseError } from '../erreurs.ts';
import { origine } from '../securite/urls.ts';
import { analyser, attribut, tous, texte, un, type Element } from './dom.ts';
import { dateFrancaise, empreinte } from './normalisation.ts';
import { VERSANTS_CARTE } from './referentiel.ts';
import {
  AUCUN_RESULTAT,
  DATE_EN_LIGNE,
  DEPARTEMENT_LOCALISATION,
  LIBELLES_CARTE,
  LISTE,
  REFERENCE_URL,
} from './selecteurs.ts';
import { PageAbsenteError, type SourcePages } from './source.ts';
import { PAGES_MAX, urlRecherche } from './url.ts';

export interface Carte {
  id_offre: string;
  url: string;
  titre: string;
  employeur: string | null;
  versant: 'FPE' | 'FPT' | 'FPH' | null;
  domaine: string | null;
  /** Texte brut de la localisation : « Loiret (45) ». */
  localisation: string | null;
  departement: string | null;
  date_publication: string | null;
  empreinte_carte: string;
}

export interface PageListe {
  /** Nombre total d'offres annoncé par le site pour la recherche. */
  total: number;
  cartes: Carte[];
  suivante: boolean;
}

/** Valeur d'une ligne `ul.fr-card__desc li` repérée par son libellé caché (« Employeur : »). */
function ligne(carte: Element, libelle: string): string | null {
  const cible = libelle.toLowerCase();
  const li = tous(LISTE.lignes, carte).find((l) => texte(un(LISTE.libelleCache, l)).toLowerCase().startsWith(cible));
  if (!li) return null;
  return (
    texte(li)
      .slice(texte(un(LISTE.libelleCache, li)).length)
      .trim() || null
  );
}

function lireCarte(el: Element, rang: number): Carte {
  const etape = 'lire-cartes';
  const lien = un(LISTE.lienTitre, el);
  if (!lien) throw new CasseError(etape, `carte ${rang} : lien vers l'offre introuvable (${LISTE.lienTitre})`);
  const titre = texte(lien);
  let chemin: string;
  try {
    chemin = new URL(attribut(lien, 'href') ?? '', origine('site')).pathname;
  } catch {
    throw new CasseError(etape, `carte ${rang} : lien invalide`);
  }
  const reference = REFERENCE_URL.exec(chemin)?.[1];
  if (!titre || !reference || !chemin.startsWith('/offre-emploi/')) {
    throw new CasseError(etape, `carte ${rang} : titre ou référence introuvable (${chemin})`);
  }
  const localisation = ligne(el, LIBELLES_CARTE.localisation);
  const libelleVersant = ligne(el, LIBELLES_CARTE.versant);
  const employeur = ligne(el, LIBELLES_CARTE.employeur);
  const domaine = texte(un(LISTE.domaine, el)) || null;
  const date = tous(LISTE.lignes, el)
    .map((li) => DATE_EN_LIGNE.exec(texte(li)))
    .find(Boolean);
  return {
    id_offre: reference,
    // URL reconstruite sur l'origine du site : jamais d'URL étrangère en base.
    url: new URL(chemin, origine('site')).href,
    titre,
    employeur,
    versant: (libelleVersant && VERSANTS_CARTE[libelleVersant.toLowerCase()]) || null,
    domaine,
    localisation,
    departement: (localisation && DEPARTEMENT_LOCALISATION.exec(localisation)?.[2]?.toUpperCase()) || null,
    date_publication: date ? dateFrancaise(date[1], date[2], date[3]) : null,
    empreinte_carte: empreinte(titre, employeur, libelleVersant, domaine, localisation, date?.[0]),
  };
}

export function lirePageListe(html: string): PageListe {
  const racine = analyser(html);
  const compteur = un(LISTE.compteur, racine);
  if (!compteur) throw new CasseError('lire-compteur', `compteur de résultats introuvable (${LISTE.compteur})`);
  const nombre = un(LISTE.compteurNombre, compteur);
  let total: number;
  if (nombre) {
    total = Number(texte(nombre).replace(/\D/g, ''));
  } else if (AUCUN_RESULTAT.test(texte(compteur))) {
    total = 0;
  } else {
    throw new CasseError('lire-compteur', `compteur illisible : « ${texte(compteur).slice(0, 80)} »`);
  }
  const cartes = tous(LISTE.carte, racine).map(lireCarte);
  const suivante = un(LISTE.pageSuivante, racine) !== null;
  if (total > 0 && cartes.length === 0 && suivante) {
    throw new CasseError('lire-cartes', `${total} offres annoncées mais aucune carte lue (${LISTE.carte})`);
  }
  return { total, cartes, suivante };
}

export interface ResultatRecherche {
  nom: string;
  pages: number;
  total: number;
  cartes: Carte[];
  /** Cartes écartées par le filtre local de versant. */
  ecartees: number;
  /** Plafond de pages atteint : des offres manquent, la collecte n'est pas complète. */
  tronquee: boolean;
}

/** Parcourt toutes les pages d'une recherche. Les URL de page sont construites par le code, pas lues sur le site. */
export async function parcourirRecherche(source: SourcePages, recherche: Recherche): Promise<ResultatRecherche> {
  const cartes: Carte[] = [];
  let total = 0;
  let page = 1;
  let tronquee = false;
  for (;;) {
    const etape = page === 1 ? 'ouvrir-recherche' : 'page-suivante';
    let html: string;
    try {
      html = await source.html(urlRecherche(recherche, page), etape);
    } catch (e) {
      // Une page de résultats introuvable n'est pas une offre retirée : l'URL de recherche ne marche plus.
      if (e instanceof PageAbsenteError) throw new CasseError(etape, e.message);
      throw e;
    }
    const lue = lirePageListe(html);
    if (page === 1) total = lue.total;
    cartes.push(...lue.cartes);
    if (!lue.suivante || lue.cartes.length === 0) break;
    if (page === PAGES_MAX) {
      tronquee = true;
      break;
    }
    page++;
  }
  // Le filtre « versant » du site n'est pas fiable : filtrage local. Un libellé inconnu est conservé (pas de perte).
  const versants = recherche.versants;
  const gardees = versants?.length ? cartes.filter((c) => c.versant === null || versants.includes(c.versant)) : cartes;
  return {
    nom: recherche.nom,
    pages: page,
    total,
    cartes: gardees,
    ecartees: cartes.length - gardees.length,
    tronquee,
  };
}
