// Page d'une offre → champs structurés (lus par le code), texte brut à résumer (lu par Claude) et empreinte.
import type { AnyNode } from 'domhandler';
import { CasseError } from '../erreurs.ts';
import type { Offre } from '../db/schema.ts';
import { analyser, tous, texte, un, type Element, type Noeud } from './dom.ts';
import { dateNumerique, empreinte, normaliserTexte } from './normalisation.ts';
import { ACCORDEONS_UTILES, DATE_LIMITE, DETAIL, LIBELLES_DETAIL, NON_RENSEIGNE, VACANCE } from './selecteurs.ts';

export interface Detail {
  id_offre: string;
  titre: string;
  employeur: string | null;
  /** Texte « Localisation » de la page : adresse, commune, service ou département selon l'offre. */
  lieu: string | null;
  code_postal: string | null;
  commune: string | null;
  departement: string | null;
  categorie: Offre['categorie'];
  type_contrat: Offre['type_contrat'];
  management: boolean | null;
  teletravail_possible: boolean | null;
  metier: string | null;
  domaine: string | null;
  date_publication: string | null;
  date_limite_candidature: string | null;
  date_prise_poste: string | null;
  /** Texte à résumer, coordonnées retirées. Jamais conservé en base. */
  texte_brut: string;
  empreinte_detail: string;
}

const BLOCS = new Set([
  'p',
  'div',
  'li',
  'ul',
  'ol',
  'section',
  'tr',
  'table',
  'br',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
]);

const IGNORES = new Set(['script', 'style', 'button']);

/** Morceaux de texte d'un nœud : `\n` autour des blocs, `## ` devant les intertitres, `- ` devant les puces. */
function morceaux(n: AnyNode): string[] {
  // Les retours à la ligne du source HTML ne sont pas des fins de ligne : seuls les blocs en créent.
  if (n.type === 'text') return [n.data.replace(/\s+/g, ' ')];
  if (n.type !== 'tag' || IGNORES.has(n.name)) return [];
  const bloc = BLOCS.has(n.name) ? ['\n'] : [];
  const prefixe = /^h[2-4]$/.test(n.name) ? ['## '] : n.name === 'li' ? ['- '] : [];
  return [...bloc, ...prefixe, ...n.children.flatMap(morceaux), ...bloc];
}

/** Texte avec retours à la ligne aux blocs et `## ` devant les intertitres (lisible par un modèle). */
function texteLignes(racine: AnyNode): string {
  return morceaux(racine)
    .join('')
    .split('\n')
    .map(normaliserTexte)
    .filter((l) => l && l !== '-' && l !== '##')
    .join('\n');
}

const COURRIEL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
const TELEPHONE = /(?<![\d/])(?:\+33\s?|0)[1-9](?:[\s.-]?\d{2}){4}(?![\d/])/g;

/** Retire e-mails et numéros de téléphone (CONFORMITE.md règle 5) avant tout écrit sur disque. */
export const retirerCoordonnees = (t: string) =>
  t.replace(COURRIEL, '[coordonnée retirée]').replace(TELEPHONE, '[coordonnée retirée]');

const valeur = (t: string | null | undefined) => (t && !NON_RENSEIGNE.test(t) ? t : null);

function ouiNon(t: string | null): boolean | null {
  if (!t) return null;
  if (/^oui$/i.test(t)) return true;
  if (/^non$/i.test(t)) return false;
  return null;
}

function categorie(t: string | null): Offre['categorie'] {
  const m = t && /cat[ée]gorie\s+(A\+|A|B|C)(?![\w+])/i.exec(t);
  return m ? (m[1].toUpperCase() as Offre['categorie']) : null;
}

function nature(t: string | null): Offre['type_contrat'] {
  if (!t) return null;
  const c = t.toLowerCase();
  if (c.includes('uniquement aux contractuels')) return 'contractuel';
  if (c.includes('réservé aux fonctionnaires')) return 'titulaire';
  if (c.includes('titulaires et aux contractuels')) return 'titulaire_ou_contractuel';
  return null;
}

const estTag = (n: AnyNode, nom: string) => n.type === 'tag' && n.name === nom;

/** Première ligne d'un élément, sans son libellé caché (`span.sr-only`) ni ce qui suit un `<br>` (service secondaire). */
function premiereLigne(el: Element | null): string | null {
  if (!el) return null;
  const finLigne = el.children.findIndex((n) => estTag(n, 'br'));
  const ligne = finLigne === -1 ? el.children : el.children.slice(0, finLigne);
  const visibles = ligne.filter((n) => !(n.type === 'tag' && n.attribs.class === 'sr-only'));
  return valeur(normaliserTexte(visibles.map(texte).join(' ')));
}

/** Map libellé → valeur à partir d'éléments ; `extraire` renvoie `null` pour ignorer un élément. */
function parLibelle(elements: Element[], extraire: (el: Element) => [string, string] | null): Map<string, string> {
  const paires = elements.map(extraire).filter((p): p is [string, string] => p !== null && p[0] !== '');
  return new Map(paires);
}

interface JobPosting {
  title?: string;
  datePosted?: string;
  industry?: string;
  jobLocation?: { address?: { postalCode?: string } };
}

function analyserJsonLd(script: Element): JobPosting | null {
  try {
    const d = JSON.parse(texte(script)) as { '@type'?: string } & JobPosting;
    return d['@type'] === 'JobPosting' ? d : null;
  } catch {
    // JSON-LD illisible : les zones HTML suffisent, l'absence de champs obligatoires est contrôlée plus bas.
    return null;
  }
}

const lireJsonLd = (racine: Noeud): JobPosting =>
  tous(DETAIL.jsonLd, racine)
    .map(analyserJsonLd)
    .find((d) => d !== null) ?? {};

export function lireDetail(html: string, idAttendu: string): Detail {
  const etape = 'lire-detail';
  const racine = analyser(html);

  const reference = texte(un(DETAIL.reference, racine)).split(':').pop()?.trim();
  if (reference !== idAttendu) {
    throw new CasseError(etape, `référence « ${reference ?? ''} » au lieu de « ${idAttendu} » (${DETAIL.reference})`);
  }
  const jsonLd = lireJsonLd(racine);
  const titre = texte(un(DETAIL.titre, racine)) || normaliserTexte(jsonLd.title ?? '');
  if (!titre) throw new CasseError(etape, `titre introuvable (${DETAIL.titre})`);

  const cellules = parLibelle(tous(DETAIL.cellules, racine), (li) => {
    const libelle = texte(un(DETAIL.libelleCellule, li));
    return [libelle, texte(li).slice(libelle.length).trim()];
  });
  if (!cellules.has(LIBELLES_DETAIL.categorie) || !cellules.has(LIBELLES_DETAIL.nature)) {
    throw new CasseError(etape, `tableau des caractéristiques introuvable (${DETAIL.cellules})`);
  }

  const accordeons = parLibelle(tous(DETAIL.accordeons, racine), (section) => {
    const contenu = un(DETAIL.contenuAccordeon, section);
    return contenu ? [texte(un(DETAIL.libelleAccordeon, section)), texteLignes(contenu)] : null;
  });

  const texteLibre = un(DETAIL.texteLibre, racine);
  if (!texteLibre) throw new CasseError(etape, `texte de l'offre introuvable (${DETAIL.texteLibre})`);
  const libre = texteLignes(texteLibre);

  const lieu = premiereLigne(un(DETAIL.lieu, racine));
  const adresse = lieu && /\b(\d{5})\s+(.+)$/.exec(lieu);
  const departementJsonLd = /\((\d{2,3}|2[AB])\)/i.exec(jsonLd.jobLocation?.address?.postalCode ?? '')?.[1];
  const dateLimite = DATE_LIMITE.exec(texte(racine))?.[1];
  const vacance = VACANCE.exec(accordeons.get(LIBELLES_DETAIL.statutPoste) ?? '')?.[1];

  const employeur = premiereLigne(un(DETAIL.employeur, racine));
  const caracteristiques = [...cellules].map(([l, v]) => `${l} : ${v}`);
  const aPropos = ACCORDEONS_UTILES.filter((l) => accordeons.has(l)).map((l) => `## ${l}\n${accordeons.get(l)}`);

  return {
    id_offre: reference,
    titre,
    employeur,
    lieu,
    code_postal: adresse ? adresse[1] : null,
    commune: adresse ? normaliserTexte(adresse[2]) : null,
    departement: departementJsonLd?.toUpperCase() ?? null,
    categorie: categorie(cellules.get(LIBELLES_DETAIL.categorie) ?? null),
    type_contrat: nature(cellules.get(LIBELLES_DETAIL.nature) ?? null),
    management: ouiNon(valeur(cellules.get(LIBELLES_DETAIL.management))),
    teletravail_possible: ouiNon(valeur(cellules.get(LIBELLES_DETAIL.teletravail))),
    metier: valeur(accordeons.get(LIBELLES_DETAIL.metier)?.split('\n')[0]),
    domaine: valeur(normaliserTexte(jsonLd.industry ?? '')) ?? null,
    date_publication: jsonLd.datePosted ? dateNumerique(jsonLd.datePosted) : null,
    date_limite_candidature: dateLimite ? dateNumerique(dateLimite) : null,
    date_prise_poste: vacance ? dateNumerique(vacance) : null,
    texte_brut: retirerCoordonnees(
      [
        `# ${titre}`,
        `Employeur : ${employeur ?? '?'}`,
        `Lieu : ${lieu ?? '?'}`,
        ...caracteristiques,
        '',
        libre,
        '',
        ...aPropos,
      ]
        .join('\n')
        .trim(),
    ),
    // Parties stables seulement : ni offres recommandées, ni présentation de l'employeur, ni attributs générés.
    empreinte_detail: empreinte(
      titre,
      employeur,
      lieu,
      caracteristiques.join('\n'),
      libre,
      aPropos.join('\n'),
      dateLimite,
    ),
  };
}
