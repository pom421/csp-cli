// Collecte quotidienne, stratégie 2 (docs/strategie.md) : [Site] périmètre sans mot-clé, publications récentes →
// [Carte] versant et domaine → [Détail] expérience et mots-clés en mots entiers → base, file « à résumer » → trajets.
// Les offres écartées après ouverture sont mémorisées et jamais rouvertes ; les offres retenues sont revérifiées par
// roulement. --dry-run : listes seules, comparées à la base ouverte en lecture seule (ni détail, ni géocodage, ni trajets).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { chemins, lireRecherches, type Recherche } from './config.ts';
import { Depot } from './db/depot.ts';
import type { ChampsCode, MotifEcart, Offre, Statut } from './db/schema.ts';
import { ecrireDiagnostic, sourceMemorisante } from './diagnostic.ts';
import { CasseError, codeDeSortie, UserError } from './erreurs.ts';
import { Geocodeur, sourceIgn, type SourceGeocodage } from './geo/geocodage.ts';
import type { Lieu } from './geo/lieux.ts';
import type { FournisseurTrajet } from './geo/trajets.ts';
import { formaterTrajetsRecherches, trajetsDuJour, type BilanTrajetsRecherche } from './trajets.ts';
import { dossierPrive, ecrireFichierPrive } from './securite/fichiers.ts';
import { joursAvant } from './purge.ts';
import { lireDetail, type Detail } from './scraper/detail.ts';
import { parcourirRecherche, type Carte, type Periode, type ResultatRecherche } from './scraper/liste.ts';
import { contientMotExact, empreinteIdentite } from './scraper/normalisation.ts';
import { FENETRES_PUBLICATION } from './scraper/referentiel.ts';
import { PageAbsenteError, sourceHttp, type SourcePages } from './scraper/source.ts';

/** Absences consécutives avant de considérer une offre expirée (PLAN §5, liste complète seulement). */
export const SEUIL_EXPIRATION = 3;
/** Une offre retenue expire ce nombre de jours après sa publication (stratégie 2). */
export const DUREE_VIE_JOURS = 90;
/** Une offre retenue est relue au plus tard après ce nombre de jours (revérification par roulement). */
export const REVERIFICATION_JOURS = 7;
/** Premier import, faute de `premier_import_jours` dans la recherche. */
export const PREMIER_IMPORT_JOURS = 30;

export interface Ecriture {
  nouvelles: string[];
  modifiees: string[];
  inchangees: number;
  republications: { id_offre: string; republication_de: string }[];
  expirees: string[];
  cloturees: string[];
  /** Offre listée mais page retirée avant le téléchargement du détail. */
  pages_retirees: string[];
  /** Ouvertes puis écartées (mémorisées, jamais rouvertes), par motif. */
  ecartees: Record<MotifEcart, string[]>;
  /** Déjà écartées un jour précédent : pas rouvertes. */
  deja_ecartees: number;
  /** Offres retenues relues par roulement ; celles dont la page a disparu sont passées en expirées. */
  reverifiees: number;
  retirees: string[];
  /** Publiées depuis plus de `DUREE_VIE_JOURS`. */
  expirees_age: string[];
  /** Mots-clés trouvés, par offre retenue aujourd'hui (pour juger des termes trop bavards). */
  mots: Record<string, string[]>;
  a_resumer: number;
}

export interface BilanGeo {
  /** Appels au géocodeur (les lieux déjà vus viennent du cache). */
  appels: number;
  /** Offres enregistrées sans coordonnées (lieu introuvable ou géocodeur en panne). */
  non_localisees: number;
  panne: string | null;
}

export interface BilanCollecte {
  recherches: Omit<ResultatRecherche, 'cartes'>[];
  /** Offres distinctes vues (une offre peut sortir dans plusieurs recherches). */
  cartes: (Carte & { recherches: string[] })[];
  nouvelles: string[];
  /** Déjà en base et non expirées. */
  connues: string[];
  /** Expirées en base mais de nouveau en ligne. */
  reapparues: string[];
  /** En base, non expirées, absentes aujourd'hui ; `null` si la collecte est partielle (aucune absence comptée). */
  absentes: string[] | null;
  /** Pourquoi les absences ne sont pas comptées. */
  partielle: string | null;
  /** Résultat de l'écriture en base ; `null` en --dry-run. */
  ecriture: Ecriture | null;
  /** `null` en --dry-run. */
  geo: BilanGeo | null;
  /** Un bilan par recherche qui a un point de départ (`depart`) ; `null` en --dry-run. */
  trajets: BilanTrajetsRecherche[] | null;
}

export interface OptionsCollecte {
  dryRun: boolean;
  recherche?: string;
  source?: SourcePages;
  base?: string;
  dossierBrut?: string;
  recherches?: Recherche[];
  maintenant?: () => Date;
  dossierDiagnostics?: string;
  geocodage?: SourceGeocodage;
  fournisseurTrajet?: FournisseurTrajet;
  /** Progression (une ligne par page lue ou par offre ouverte) ; la CLI l'écrit sur la sortie d'erreur. */
  suivi?: (message: string) => void;
}

/** Date du jour à Paris (AAAA-MM-JJ), quel que soit le fuseau de la machine. */
export const jourParis = (d: Date) => d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });

type CarteVue = Carte & { recherches: string[] };

/** Réducteur : ajoute la carte d'une recherche, ou seulement le nom de la recherche si l'offre est déjà vue. */
const ajouterCarte = (parId: Map<string, CarteVue>, nom: string, c: Carte): Map<string, CarteVue> => {
  const deja = parId.get(c.id_offre);
  const recherches = deja ? [...new Set([...deja.recherches, nom])] : [nom];
  return parId.set(c.id_offre, { ...(deja ?? c), recherches });
};

/** Dédoublonne les cartes de toutes les recherches en gardant la liste des recherches de chaque offre. */
export function fusionner(resultats: ResultatRecherche[]): CarteVue[] {
  const parId = resultats.reduce(
    (acc, r) => r.cartes.reduce((m, c) => ajouterCarte(m, r.nom, c), acc),
    new Map<string, CarteVue>(),
  );
  return [...parId.values()].sort((a, b) => a.id_offre.localeCompare(b.id_offre));
}

/** Champs de la base à partir de la carte (vignette) et de la page détail. */
export function champsOffre(carte: Carte, d: Detail): ChampsCode {
  const employeur = carte.employeur ?? d.employeur;
  return {
    id_offre: carte.id_offre,
    url: carte.url,
    titre: d.titre,
    employeur,
    versant: carte.versant,
    categorie: d.categorie,
    type_contrat: d.type_contrat,
    temps_travail: null,
    metier: d.metier,
    domaine: carte.domaine ?? d.domaine,
    adresse: d.lieu,
    commune: d.commune,
    code_postal: d.code_postal,
    departement: carte.departement ?? d.departement,
    management: d.management,
    teletravail_possible: d.teletravail_possible,
    date_publication: carte.date_publication ?? d.date_publication,
    date_limite_candidature: d.date_limite_candidature,
    date_prise_poste: d.date_prise_poste,
    empreinte_carte: carte.empreinte_carte,
    empreinte_detail: d.empreinte_detail,
    empreinte_identite: empreinteIdentite(d.titre, employeur, d.commune ?? d.lieu ?? carte.departement),
  };
}

/** Identifiant utilisable comme nom de fichier (déjà contraint par le motif de référence, revérifié ici). */
const NOM_SUR = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function selectionnerRecherches(options: OptionsCollecte): Recherche[] {
  const recherches = options.recherches ?? lireRecherches();
  if (!options.recherche) return recherches;
  const choisies = recherches.filter((r) => r.nom === options.recherche);
  if (!choisies.length) throw new UserError(`Recherche inconnue : ${options.recherche}`);
  return choisies;
}

/** Statut en base de chaque offre connue (vide si la base n'existe pas encore). */
function statutsEnBase(depot: Depot): Map<string, Statut> {
  return new Map(depot.listerOffres().map((o) => [o.id_offre, o.statut]));
}

/** Une recherche qui avait au moins ce nombre d'offres actives et n'en rend plus aucune : le site a sans doute changé. */
export const SEUIL_RECHERCHE_VIDE = 5;
/**
 * Part de pages détail introuvables (404) au-delà de laquelle le format des liens a sans doute changé, à partir de
 * 10 pages (en dessous, deux offres retirées le même jour suffiraient à dépasser 20 %).
 */
export const PART_DETAILS_ABSENTS = 0.2;
const MIN_DETAILS_CONTROLES = 10;

/**
 * Résultat suspect (PLAN §6) : une recherche tombée à zéro alors qu'elle avait des offres actives. Sans ce garde-fou,
 * une page de résultats cassée mais lisible ferait expirer toutes les offres en trois jours.
 */
export function verifierResultats(resultats: ResultatRecherche[], activesParRecherche: Map<string, number>): void {
  for (const r of resultats) {
    // Avec le filtre de date du site, une journée sans publication est normale.
    if (r.fenetre) continue;
    const actives = activesParRecherche.get(r.nom) ?? 0;
    if (r.total === 0 && actives >= SEUIL_RECHERCHE_VIDE) {
      throw new CasseError(
        'resultat-suspect',
        `recherche « ${r.nom} » : 0 offre annoncée alors que ${actives} sont actives en base (filtres de l'URL ?)`,
      );
    }
  }
}

/** Jours entiers entre deux dates AAAA-MM-JJ. */
const ecartJours = (avant: string, apres: string) =>
  Math.round((Date.parse(`${apres}T12:00:00Z`) - Date.parse(`${avant}T12:00:00Z`)) / 86_400_000);

/**
 * Publications à lire : la plus courte fenêtre du site qui couvre depuis la dernière collecte réussie (marge d'un jour) ;
 * au-delà de 14 jours, liste complète triée par date jusqu'à la dernière collecte (marge de 2 jours). Premier import :
 * `premier_import_jours`.
 */
export function periodeCollecte(derniere: string | null, jour: string, r: Recherche): Periode {
  if (!derniere) return { depuis: joursAvant(jour, r.premier_import_jours ?? PREMIER_IMPORT_JOURS) };
  const fenetre = FENETRES_PUBLICATION.find((f) => f.jours >= ecartJours(derniere, jour) + 1);
  return fenetre ? { fenetre: fenetre.valeur } : { depuis: joursAvant(derniere, 2) };
}

export async function collecte(options: OptionsCollecte): Promise<BilanCollecte> {
  const recherches = selectionnerRecherches(options);
  const memoire = sourceMemorisante(options.source ?? sourceHttp);
  const maintenant = options.maintenant ?? (() => new Date());
  const base = options.base ?? chemins().base;
  const diagnostiquer = (e: unknown) => {
    if (!(e instanceof CasseError)) return;
    e.diagnostic = ecrireDiagnostic(options.dossierDiagnostics ?? chemins().diagnostics, {
      jour: jourParis(maintenant()),
      maintenant: maintenant(),
      erreur: e,
      page: memoire.derniere(),
    });
  };
  try {
    return await executer(options, recherches, memoire.source, maintenant, base);
  } catch (e) {
    diagnostiquer(e);
    throw e;
  }
}

async function executer(
  options: OptionsCollecte,
  recherches: Recherche[],
  source: SourcePages,
  maintenant: () => Date,
  base: string,
): Promise<BilanCollecte> {
  const jour = jourParis(maintenant());
  if (options.dryRun) {
    const apercu = { ecriture: null, geo: null, trajets: null };
    if (!existsSync(base)) {
      const resultats = await parcourirToutes(source, recherches, null, jour, options.suivi);
      return { ...comparer(resultats, new Map(), options.recherche), ...apercu };
    }
    const depot = new Depot(base, { lectureSeule: true });
    try {
      const resultats = await parcourirToutes(source, recherches, derniereCollecte(depot), jour, options.suivi);
      verifierResultats(resultats, depot.activesParRecherche());
      return { ...comparer(resultats, statutsEnBase(depot), options.recherche), ...apercu };
    } finally {
      depot.fermer();
    }
  }

  const depot = new Depot(base);
  const derniere = derniereCollecte(depot);
  const execution = depot.commencerExecution(maintenant().toISOString());
  try {
    const resultats = await parcourirToutes(source, recherches, derniere, jour, options.suivi);
    verifierResultats(resultats, depot.activesParRecherche());
    const bilan = comparer(resultats, statutsEnBase(depot), options.recherche);
    const geocodeur = new Geocodeur(depot, options.geocodage ?? sourceIgn, jour);
    const { ecriture, non_localisees } = await ecrire(depot, source, bilan, {
      jour,
      dossierBrut: options.dossierBrut ?? chemins().brut,
      geocodeur,
      recherches: new Map(recherches.map((r) => [r.nom, r])),
      suivi: options.suivi,
    });
    const geo: BilanGeo = {
      appels: geocodeur.appels,
      non_localisees,
      panne: geocodeur.panne,
    };
    options.suivi?.('Trajets…');
    const trajets = await trajetsDuJour(depot, recherches, {
      jour,
      geocodage: geocodeur.source,
      fournisseur: options.fournisseurTrajet,
    });
    depot.terminerExecution(execution, {
      fin: maintenant().toISOString(),
      // Liste limitée aux publications récentes : normal (stratégie 2). Incomplète : une seule recherche, ou plafond.
      statut: options.recherche || bilan.recherches.some((r) => r.tronquee) ? 'incomplete' : 'complete',
      code_sortie: 0,
      nb_cartes: bilan.cartes.length,
      nb_nouvelles: ecriture.nouvelles.length,
      nb_modifiees: ecriture.modifiees.length,
      nb_expirees: ecriture.expirees.length + ecriture.expirees_age.length + ecriture.retirees.length,
      message: bilan.partielle,
    });
    return { ...bilan, ecriture, geo, trajets };
  } catch (e) {
    depot.terminerExecution(execution, {
      fin: maintenant().toISOString(),
      statut: 'echec',
      code_sortie: codeDeSortie(e),
      // Le dossier de diagnostic n'est pas encore connu ici : il est écrit juste après, par `collecte`.
      message: (e as Error).message,
    });
    throw e;
  } finally {
    depot.fermer();
  }
}

/** Jour (Paris) de la dernière collecte réussie ; `null` : premier import. */
function derniereCollecte(depot: Depot): string | null {
  const e = depot.derniereCollecteReussie();
  return e ? jourParis(new Date(e.debut)) : null;
}

async function parcourirToutes(
  source: SourcePages,
  recherches: Recherche[],
  derniere: string | null,
  jour: string,
  suivi?: (message: string) => void,
): Promise<ResultatRecherche[]> {
  const resultats: ResultatRecherche[] = [];
  for (const r of recherches) {
    resultats.push(await parcourirRecherche(source, r, periodeCollecte(derniere, jour, r), suivi));
  }
  return resultats;
}

/** « 12 min », « 1 h 05 » : reste estimé d'après la durée moyenne des offres déjà ouvertes. */
function resteEstime(debut: number, faites: number, total: number): string {
  const min = Math.round((((Date.now() - debut) / faites) * (total - faites)) / 60_000);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`;
}

const issueLisible = (i: Issue): string =>
  i.type === 'retiree'
    ? 'page retirée'
    : i.type === 'ecartee'
      ? i.motif === 'experience'
        ? 'écartée (expérience)'
        : 'écartée (aucun mot-clé)'
      : `retenue${i.mots.length ? ` (${i.mots.join(', ')})` : ''}${i.type === 'inchangee' ? ', inchangée' : ''}`;

type Partition = Pick<BilanCollecte, 'nouvelles' | 'connues' | 'reapparues'>;

/** Réducteur : range chaque offre vue selon son statut en base (absente, expirée ou connue). */
const classer =
  (enBase: Map<string, Statut>) =>
  (p: Partition, { id_offre }: Carte): Partition => {
    const statut = enBase.get(id_offre);
    if (statut === undefined) return { ...p, nouvelles: [...p.nouvelles, id_offre] };
    if (statut === 'expiree') return { ...p, reapparues: [...p.reapparues, id_offre] };
    return { ...p, connues: [...p.connues, id_offre] };
  };

function raisonPartielle(resultats: ResultatRecherche[], rechercheUnique: string | undefined): string | null {
  if (rechercheUnique) return `une seule recherche lancée (${rechercheUnique})`;
  const tronquees = resultats.filter((r) => r.tronquee).map((r) => r.nom);
  if (tronquees.length) return `plafond de pages atteint : ${tronquees.join(', ')}`;
  // Stratégie 2 : seules les publications récentes sont listées, une offre ancienne absente n'a rien d'anormal.
  if (resultats.some((r) => r.fenetre || r.depuis))
    return 'publications récentes seulement (revérification par roulement)';
  return null;
}

function comparer(
  resultats: ResultatRecherche[],
  enBase: Map<string, Statut>,
  rechercheUnique: string | undefined,
): Omit<BilanCollecte, 'ecriture' | 'geo' | 'trajets'> {
  const cartes = fusionner(resultats);
  const vus = new Set(cartes.map((c) => c.id_offre));
  const partielle = raisonPartielle(resultats, rechercheUnique);
  const absentes = [...enBase]
    .filter(([id, statut]) => statut !== 'expiree' && !vus.has(id))
    .map(([id]) => id)
    .sort();
  return {
    recherches: resultats.map(({ cartes: _c, ...r }) => r),
    cartes,
    ...cartes.reduce(classer(enBase), { nouvelles: [], connues: [], reapparues: [] }),
    absentes: partielle ? null : absentes,
    partielle,
  };
}

/** Mots-clés trouvés en mots entiers dans le texte (titre compris). */
export const motsTrouves = (mots: readonly string[], texte: string): string[] =>
  mots.filter((m) => contientMotExact(texte, m));

/**
 * Filtres [Détail] de chaque recherche de l'offre : expérience exclue, puis mots-clés (une recherche sans mot-clé garde
 * tout). Renvoie les recherches qui gardent l'offre et les mots trouvés, ou le motif d'écart si aucune ne la garde.
 */
export function filtrerDetail(
  noms: readonly string[],
  recherches: ReadonlyMap<string, Recherche>,
  detail: Pick<Detail, 'titre' | 'texte_brut' | 'experience'>,
): { gardee_par: string[]; mots: string[] } | { motif: MotifEcart } {
  const texte = `${detail.titre}\n${detail.texte_brut}`;
  const parExperience = noms.filter((nom) => {
    const exclues = recherches.get(nom)?.experiences_exclues ?? [];
    return !detail.experience || !exclues.includes(detail.experience);
  });
  if (!parExperience.length) return { motif: 'experience' };
  const mots = new Set<string>();
  const gardee_par = parExperience.filter((nom) => {
    const cles = recherches.get(nom)?.mots_cles ?? [];
    if (!cles.length) return true;
    const trouves = motsTrouves(cles, texte);
    trouves.forEach((m) => mots.add(m));
    return trouves.length > 0;
  });
  return gardee_par.length ? { gardee_par, mots: [...mots] } : { motif: 'mots_cles' };
}

const lieuDe = (c: ChampsCode): Lieu => ({
  adresse: c.adresse,
  code_postal: c.code_postal,
  commune: c.commune,
  departement: c.departement,
});

/** Ce qui est arrivé à une offre lors de l'écriture. */
type Issue = (
  | { type: 'retiree' }
  | { type: 'ecartee'; motif: MotifEcart }
  | { type: 'inchangee'; mots: string[] }
  | { type: 'nouvelle' | 'modifiee'; republication_de: string | null; mots: string[] }
) & { id_offre: string; localisee: boolean };

const ECRITURE_VIDE: Ecriture = {
  nouvelles: [],
  modifiees: [],
  inchangees: 0,
  republications: [],
  expirees: [],
  cloturees: [],
  pages_retirees: [],
  ecartees: { experience: [], mots_cles: [] },
  deja_ecartees: 0,
  reverifiees: 0,
  retirees: [],
  expirees_age: [],
  mots: {},
  a_resumer: 0,
};

/** Réducteur : cumule l'issue de chaque offre dans le bilan d'écriture. */
function cumuler(e: Ecriture, issue: Issue): Ecriture {
  switch (issue.type) {
    case 'retiree':
      return { ...e, pages_retirees: [...e.pages_retirees, issue.id_offre] };
    case 'ecartee':
      return { ...e, ecartees: { ...e.ecartees, [issue.motif]: [...e.ecartees[issue.motif], issue.id_offre] } };
    case 'inchangee':
      return { ...e, inchangees: e.inchangees + 1, mots: { ...e.mots, [issue.id_offre]: issue.mots } };
    case 'nouvelle':
    case 'modifiee': {
      const liste = issue.type === 'nouvelle' ? 'nouvelles' : 'modifiees';
      const republications = issue.republication_de
        ? [...e.republications, { id_offre: issue.id_offre, republication_de: issue.republication_de }]
        : e.republications;
      return {
        ...e,
        [liste]: [...e[liste], issue.id_offre],
        republications,
        mots: { ...e.mots, [issue.id_offre]: issue.mots },
        a_resumer: e.a_resumer + 1,
      };
    }
  }
}

interface ContexteEcriture {
  jour: string;
  dossierBrut: string;
  /** Offres en ligne aujourd'hui : une offre identique encore en ligne n'est pas une republication. */
  enLigne: Set<string>;
  geocodeur: Geocodeur;
  /** Recherches par nom (filtres [Détail]). */
  recherches: ReadonlyMap<string, Recherche>;
  suivi?: (message: string) => void;
}

/**
 * Télécharge le détail d'une offre, applique les filtres [Détail] et l'enregistre, en une transaction (un arrêt laisse
 * les précédentes complètes). `reverification` : offre déjà retenue, relue sans refiltrer.
 */
async function traiterOffre(
  depot: Depot,
  source: SourcePages,
  carte: CarteVue,
  ctx: ContexteEcriture,
  reverification = false,
): Promise<Issue> {
  const { id_offre } = carte;
  let detail: Detail;
  try {
    detail = lireDetail(await source.html(new URL(carte.url), 'lire-detail'), id_offre);
  } catch (err) {
    if (err instanceof PageAbsenteError) return { id_offre, type: 'retiree', localisee: false };
    throw err;
  }
  const champs = champsOffre(carte, detail);
  const filtre = reverification
    ? { gardee_par: carte.recherches, mots: [] }
    : filtrerDetail(carte.recherches, ctx.recherches, detail);
  if ('motif' in filtre) {
    ecrireTexteBrut(join(ctx.dossierBrut, 'ecartees'), id_offre, detail.texte_brut);
    depot.ecarter(id_offre, filtre.motif, ctx.jour);
    return { id_offre, type: 'ecartee', motif: filtre.motif, localisee: false };
  }
  const { gardee_par: parMots, mots } = filtre;
  // Hors transaction : un appel réseau (le cache répond pour les lieux déjà vus).
  const geo = await ctx.geocodeur.lieu(lieuDe(champs));
  const localisee = geo?.latitude != null;
  return depot.transaction((): Issue => {
    const evolution = depot.enregistrerOffre(champs, ctx.jour);
    // Géocodeur en panne : les coordonnées déjà connues sont gardées.
    if (geo) depot.poserGeo(id_offre, geo);
    parMots.forEach((nom) => depot.lierRecherche(nom, id_offre));
    if (evolution === 'inchangee') return { id_offre, type: 'inchangee', mots, localisee };
    const origine =
      evolution === 'nouvelle' && champs.empreinte_identite
        ? depot.trouverRepublication(champs.empreinte_identite, id_offre)
        : undefined;
    const republication_de = origine && !ctx.enLigne.has(origine) ? origine : null;
    if (republication_de) depot.marquerRepublication(id_offre, republication_de);
    depot.ajouterAResumer(id_offre, evolution, ecrireTexteBrut(ctx.dossierBrut, id_offre, detail.texte_brut), ctx.jour);
    return { id_offre, type: evolution, republication_de, mots, localisee };
  });
}

/** Écrit le texte à résumer en 0600 ; renvoie son chemin. */
function ecrireTexteBrut(dossierBrut: string, idOffre: string, texte: string): string {
  if (!NOM_SUR.test(idOffre)) throw new UserError(`Identifiant inattendu : ${idOffre}`);
  dossierPrive(dossierBrut);
  const chemin = join(dossierBrut, `${idOffre}.txt`);
  ecrireFichierPrive(chemin, `${texte}\n`);
  return chemin;
}

async function ecrire(
  depot: Depot,
  source: SourcePages,
  bilan: Omit<BilanCollecte, 'ecriture' | 'geo' | 'trajets'>,
  contexte: Omit<ContexteEcriture, 'enLigne'>,
): Promise<{ ecriture: Ecriture; non_localisees: number }> {
  const ctx: ContexteEcriture = { ...contexte, enLigne: new Set(bilan.cartes.map((c) => c.id_offre)) };
  const dejaEcartees = depot.ecartees(bilan.cartes.map((c) => c.id_offre));
  const issues: Issue[] = [];
  const aOuvrir = bilan.cartes.filter((c) => !dejaEcartees.has(c.id_offre));
  ctx.suivi?.(
    `${aOuvrir.length} offre(s) à ouvrir${dejaEcartees.size ? `, ${dejaEcartees.size} déjà écartée(s)` : ''}`,
  );
  const debut = Date.now();
  // Séquentiel : le délai de politesse entre deux pages du site est imposé par http.ts.
  for (const [n, carte] of aOuvrir.entries()) {
    const issue = await traiterOffre(depot, source, carte, ctx);
    issues.push(issue);
    const reste = n + 1 < aOuvrir.length ? ` — reste ~${resteEstime(debut, n + 1, aOuvrir.length)}` : '';
    ctx.suivi?.(`  ${n + 1}/${aOuvrir.length} ${issueLisible(issue)} : ${carte.titre}${reste}`);
  }
  const absents = issues.filter((i) => i.type === 'retiree').length;
  // Avant de compter les absences : une casse ne doit faire expirer aucune offre.
  if (issues.length >= MIN_DETAILS_CONTROLES && absents / issues.length > PART_DETAILS_ABSENTS) {
    throw new CasseError(
      'lire-detail',
      `${absents} pages détail sur ${issues.length} introuvables (404) : format des liens d'offre changé ?`,
    );
  }
  if (bilan.absentes) depot.noterAbsences(bilan.absentes);
  const reverif = await reverifier(depot, source, ctx);
  const enregistrees = [...issues, ...reverif].filter((i) => !['retiree', 'ecartee'].includes(i.type));
  return {
    ecriture: {
      // Une page disparue à la revérification n'est pas une « page retirée » du jour : comptée à part (`retirees`).
      ...[...issues, ...reverif.filter((i) => i.type !== 'retiree')].reduce(cumuler, ECRITURE_VIDE),
      deja_ecartees: dejaEcartees.size,
      reverifiees: reverif.length,
      retirees: reverif.filter((i) => i.type === 'retiree').map((i) => i.id_offre),
      expirees: bilan.absentes ? depot.expirer(SEUIL_EXPIRATION) : [],
      cloturees: depot.cloturer(ctx.jour),
      expirees_age: depot.expirerAnciennes(joursAvant(ctx.jour, DUREE_VIE_JOURS)),
    },
    non_localisees: enregistrees.filter((i) => !i.localisee).length,
  };
}

/** Carte reconstituée depuis la base, pour relire une offre qui n'est plus dans la liste du jour. */
const carteDe = (o: Offre, recherches: string[]): CarteVue => ({
  id_offre: o.id_offre,
  url: o.url,
  titre: o.titre,
  employeur: o.employeur,
  versant: o.versant,
  domaine: o.domaine,
  localisation: null,
  departement: o.departement,
  date_publication: o.date_publication,
  empreinte_carte: o.empreinte_carte ?? '',
  recherches,
});

/**
 * Revérification par roulement : chaque jour, au plus 1/`REVERIFICATION_JOURS` des offres actives non relues depuis
 * `REVERIFICATION_JOURS` jours (les plus anciennes d'abord). Une page disparue (404) expire l'offre ; une page modifiée
 * la renvoie au résumé. Les modifications sont comptées avec celles du jour (bilan d'écriture).
 */
async function reverifier(depot: Depot, source: SourcePages, ctx: ContexteEcriture): Promise<Issue[]> {
  const candidates = depot.aReverifier(joursAvant(ctx.jour, REVERIFICATION_JOURS - 1));
  const actives = depot.listerOffres('active').length;
  const lot = candidates.slice(0, Math.max(1, Math.ceil(actives / REVERIFICATION_JOURS)));
  const issues: Issue[] = [];
  if (lot.length) ctx.suivi?.(`Revérification de ${lot.length} offre(s) déjà retenue(s)`);
  for (const [n, o] of lot.entries()) {
    const issue = await traiterOffre(depot, source, carteDe(o, depot.recherchesDe(o.id_offre)), ctx, true);
    if (issue.type === 'retiree') depot.marquerRetiree(o.id_offre);
    issues.push(issue);
    ctx.suivi?.(
      `  ${n + 1}/${lot.length} ${issue.type === 'retiree' ? 'retirée du site' : 'toujours en ligne'} : ${o.titre}`,
    );
  }
  return issues;
}

function formaterGeo(g: BilanGeo): string[] {
  const lignes = [`Géocodage : ${g.appels} appel(s), ${g.non_localisees} offre(s) sans coordonnées`];
  if (g.panne) lignes.push(`  géocodeur en panne (repris au prochain passage) : ${g.panne}`);
  return lignes;
}

/** Bilan lisible (terminal, tâche planifiée). */
export function formaterBilan(b: BilanCollecte): string {
  const lignes = ['Recherches :'];
  for (const r of b.recherches) {
    const periode = r.fenetre ? ` [${r.fenetre}]` : r.depuis ? ` [depuis le ${r.depuis}]` : '';
    const ecart =
      (r.ecartees ? `, ${r.ecartees} écartée(s) par le versant` : '') +
      (r.ecartees_domaine ? `, ${r.ecartees_domaine} hors domaines` : '');
    const plafond = r.tronquee ? ' — PLAFOND ATTEINT, résultats tronqués' : '';
    lignes.push(`  ${r.nom}${periode} : ${r.total} annoncée(s), ${r.pages} page(s) lue(s)${ecart}${plafond}`);
  }
  const absentes = b.absentes === null ? `non comptées (${b.partielle})` : String(b.absentes.length);
  const parId = new Map(b.cartes.map((c) => [c.id_offre, c]));
  const mots = b.ecriture?.mots ?? {};
  const offre = (id: string) => {
    const c = parId.get(id);
    // Modifiée à la revérification : plus dans la liste du jour, seul l'identifiant est connu ici.
    if (!c) return [`  ${id} (revérification)`];
    const trouves = mots[id]?.length ? `    mots-clés : ${mots[id].join(', ')}` : null;
    return [
      `  ${c.titre} — ${c.employeur ?? '?'} — ${c.localisation ?? '?'} — ${c.date_publication ?? '?'}`,
      `    ${c.url}`,
      ...(trouves ? [trouves] : []),
    ];
  };
  if (!b.ecriture) {
    lignes.push(
      `Offres distinctes : ${b.cartes.length} (aperçu, rien n'est écrit)`,
      `  nouvelles : ${b.nouvelles.length}`,
      `  déjà connues : ${b.connues.length}`,
      `  réapparues : ${b.reapparues.length}`,
      `  absentes : ${absentes}`,
    );
    if (b.nouvelles.length) lignes.push('', 'Nouvelles :', ...b.nouvelles.flatMap(offre));
    return lignes.join('\n');
  }
  const e = b.ecriture;
  lignes.push(
    `Offres distinctes : ${b.cartes.length}`,
    `  nouvelles : ${e.nouvelles.length}`,
    `  modifiées : ${e.modifiees.length}`,
    `  inchangées : ${e.inchangees}`,
    `  republications : ${e.republications.length}`,
    `  pages retirées entre-temps : ${e.pages_retirees.length}`,
    `  écartées (expérience) : ${e.ecartees.experience.length}`,
    `  écartées (aucun mot-clé) : ${e.ecartees.mots_cles.length}`,
    `  déjà écartées (non rouvertes) : ${e.deja_ecartees}`,
    `  absentes : ${absentes}`,
    `Revérifiées : ${e.reverifiees}, dont ${e.retirees.length} retirée(s) du site`,
    `Expirées : ${e.expirees.length + e.retirees.length + e.expirees_age.length} (dont ${e.expirees_age.length} publiées depuis plus de ${DUREE_VIE_JOURS} jours)`,
    `Clôturées (date limite passée) : ${e.cloturees.length}`,
    `À résumer : ${e.a_resumer}`,
  );
  if (b.geo) lignes.push(...formaterGeo(b.geo));
  if (b.trajets) lignes.push(...formaterTrajetsRecherches(b.trajets));
  if (e.nouvelles.length) lignes.push('', 'Nouvelles :', ...e.nouvelles.flatMap(offre));
  if (e.modifiees.length) lignes.push('', 'Modifiées :', ...e.modifiees.flatMap(offre));
  return lignes.join('\n');
}
