// Page d'une offre → champs structurés (lus par le code), texte brut à résumer (lu par Claude) et empreinte.
import type { AnyNode } from 'domhandler';
import { CasseError } from '../erreurs.ts';
import type { Offre } from '../db/schema.ts';
import { analyser, tous, texte, un, type Element } from './dom.ts';
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

/** Texte avec retours à la ligne aux blocs et `## ` devant les intertitres (lisible par Claude). */
function texteLignes(racine: AnyNode): string {
  const morceaux: string[] = [];
  const parcourir = (n: AnyNode) => {
    if (n.type === 'text') {
      // Les retours à la ligne du source HTML ne sont pas des fins de ligne : seuls les blocs en créent.
      morceaux.push(n.data.replace(/\s+/g, ' '));
      return;
    }
    if (n.type !== 'tag') return;
    const nom = n.name;
    if (nom === 'script' || nom === 'style' || nom === 'button') return;
    if (BLOCS.has(nom)) morceaux.push('\n');
    if (/^h[2-4]$/.test(nom)) morceaux.push('## ');
    if (nom === 'li') morceaux.push('- ');
    n.children.forEach(parcourir);
    if (BLOCS.has(nom)) morceaux.push('\n');
  };
  parcourir(racine);
  return morceaux
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

/** Première ligne d'un élément, sans son libellé caché (`span.sr-only`) ni ce qui suit un `<br>` (service secondaire). */
function premiereLigne(el: Element | null): string | null {
  if (!el) return null;
  const morceaux: string[] = [];
  for (const enfant of el.children) {
    if (enfant.type === 'tag' && enfant.name === 'br') break;
    if (enfant.type === 'tag' && enfant.attribs.class === 'sr-only') continue;
    morceaux.push(texte(enfant));
  }
  return valeur(normaliserTexte(morceaux.join(' ')));
}

interface JobPosting {
  title?: string;
  datePosted?: string;
  industry?: string;
  jobLocation?: { address?: { postalCode?: string } };
}

function lireJsonLd(racine: ReturnType<typeof analyser>): JobPosting {
  for (const s of tous(DETAIL.jsonLd, racine)) {
    try {
      const d = JSON.parse(texte(s)) as { '@type'?: string } & JobPosting;
      if (d['@type'] === 'JobPosting') return d;
    } catch {
      // JSON-LD illisible : les zones HTML suffisent, l'absence de champs obligatoires est contrôlée plus bas.
    }
  }
  return {};
}

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

  const cellules = new Map<string, string>();
  for (const li of tous(DETAIL.cellules, racine)) {
    const libelle = texte(un(DETAIL.libelleCellule, li));
    if (libelle) cellules.set(libelle, texte(li).slice(libelle.length).trim());
  }
  if (!cellules.has(LIBELLES_DETAIL.categorie) || !cellules.has(LIBELLES_DETAIL.nature)) {
    throw new CasseError(etape, `tableau des caractéristiques introuvable (${DETAIL.cellules})`);
  }

  const accordeons = new Map<string, string>();
  for (const s of tous(DETAIL.accordeons, racine)) {
    const libelle = texte(un(DETAIL.libelleAccordeon, s));
    const contenu = un(DETAIL.contenuAccordeon, s);
    if (libelle && contenu) accordeons.set(libelle, texteLignes(contenu));
  }

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
