// Collecte quotidienne (PLAN §4) : recherches → cartes → détail de chaque offre → géocodage → base, file « à résumer »
// → trajets. --dry-run : liste seule, comparée à la base ouverte en lecture seule, rien n'est écrit ni téléchargé au-delà
// des listes (ni géocodage, ni filtre commune + rayon, ni trajets).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { chemins, lireRecherches, type Recherche } from './config.ts';
import { Depot } from './db/depot.ts';
import type { ChampsCode, Geo, Statut } from './db/schema.ts';
import { ecrireDiagnostic, sourceMemorisante } from './diagnostic.ts';
import { CasseError, codeDeSortie, UserError } from './erreurs.ts';
import { Geocodeur, sourceIgn, type SourceGeocodage } from './geo/geocodage.ts';
import { distanceKm, type Lieu, type Point } from './geo/lieux.ts';
import type { BilanTrajets, FournisseurTrajet } from './geo/trajets.ts';
import { formaterTrajets, trajetsDuJour } from './trajets.ts';
import { dossierPrive, ecrireFichierPrive } from './securite/fichiers.ts';
import { lireDetail, type Detail } from './scraper/detail.ts';
import { parcourirRecherche, type Carte, type ResultatRecherche } from './scraper/liste.ts';
import { empreinteIdentite } from './scraper/normalisation.ts';
import { PageAbsenteError, sourceHttp, type SourcePages } from './scraper/source.ts';

/** Absences consécutives avant de considérer une offre expirée (PLAN §5). */
export const SEUIL_EXPIRATION = 3;

export interface Ecriture {
  nouvelles: string[];
  modifiees: string[];
  inchangees: number;
  republications: { id_offre: string; republication_de: string }[];
  expirees: string[];
  cloturees: string[];
  /** Offre listée mais page retirée avant le téléchargement du détail. */
  pages_retirees: string[];
  /** Hors du rayon de toutes ses recherches : ni enregistrée, ni résumée. */
  hors_zone: string[];
  a_resumer: number;
}

export interface BilanGeo {
  /** Appels au géocodeur (les lieux déjà vus viennent du cache). */
  appels: number;
  /** Offres enregistrées sans coordonnées (lieu introuvable ou géocodeur en panne). */
  non_localisees: number;
  panne: string | null;
  /** Recherches « commune + rayon » non filtrées ce jour (centre impossible à géocoder). */
  rayons_ignores: string[];
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
  /** `null` en --dry-run ou sans adresse de départ (CSP_ORIGINE_TRAJET). */
  trajets: BilanTrajets | null;
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
  /** Adresse de départ ; par défaut CSP_ORIGINE_TRAJET. */
  origineTrajet?: string;
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
    const actives = activesParRecherche.get(r.nom) ?? 0;
    if (r.total === 0 && actives >= SEUIL_RECHERCHE_VIDE) {
      throw new CasseError(
        'resultat-suspect',
        `recherche « ${r.nom} » : 0 offre annoncée alors que ${actives} sont actives en base (filtres de l'URL ?)`,
      );
    }
  }
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
  if (options.dryRun) {
    const resultats = await parcourirToutes(source, recherches);
    const apercu = { ecriture: null, geo: null, trajets: null };
    if (!existsSync(base)) return { ...comparer(resultats, new Map(), options.recherche), ...apercu };
    const depot = new Depot(base, { lectureSeule: true });
    try {
      verifierResultats(resultats, depot.activesParRecherche());
      return { ...comparer(resultats, statutsEnBase(depot), options.recherche), ...apercu };
    } finally {
      depot.fermer();
    }
  }

  const depot = new Depot(base);
  const execution = depot.commencerExecution(maintenant().toISOString());
  const jour = jourParis(maintenant());
  try {
    const resultats = await parcourirToutes(source, recherches);
    verifierResultats(resultats, depot.activesParRecherche());
    const bilan = comparer(resultats, statutsEnBase(depot), options.recherche);
    const geocodeur = new Geocodeur(depot, options.geocodage ?? sourceIgn, jour);
    const zones = await zonesRecherches(geocodeur, recherches);
    const { ecriture, non_localisees } = await ecrire(depot, source, bilan, {
      jour,
      dossierBrut: options.dossierBrut ?? chemins().brut,
      geocodeur,
      zones,
    });
    const geo: BilanGeo = {
      appels: geocodeur.appels,
      non_localisees,
      panne: geocodeur.panne,
      rayons_ignores: [...zones].filter(([, z]) => z === null).map(([nom]) => nom),
    };
    const trajets = await trajetsDuJour(depot, {
      jour,
      geocodage: geocodeur.source,
      fournisseur: options.fournisseurTrajet,
      origine: options.origineTrajet,
    });
    depot.terminerExecution(execution, {
      fin: maintenant().toISOString(),
      statut: bilan.partielle ? 'incomplete' : 'complete',
      code_sortie: 0,
      nb_cartes: bilan.cartes.length,
      nb_nouvelles: ecriture.nouvelles.length,
      nb_modifiees: ecriture.modifiees.length,
      nb_expirees: ecriture.expirees.length,
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

async function parcourirToutes(source: SourcePages, recherches: Recherche[]): Promise<ResultatRecherche[]> {
  const resultats: ResultatRecherche[] = [];
  for (const r of recherches) resultats.push(await parcourirRecherche(source, r));
  return resultats;
}

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
  return tronquees.length ? `plafond de pages atteint : ${tronquees.join(', ')}` : null;
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

/** Centre et rayon d'une recherche « commune + rayon » ; `null` : centre non géocodé ce jour, pas de filtre. */
type Zone = { centre: Point; rayon_km: number } | null;

/** Zones des recherches qui ont une commune et un rayon (les autres ne filtrent rien localement). */
async function zonesRecherches(geocodeur: Geocodeur, recherches: Recherche[]): Promise<Map<string, Zone>> {
  const zones = new Map<string, Zone>();
  for (const r of recherches) {
    const { commune, rayon_km } = r.localisation ?? {};
    if (commune === undefined || rayon_km === undefined) continue;
    const centre = await geocodeur.commune(commune);
    zones.set(r.nom, centre ? { centre, rayon_km } : null);
  }
  return zones;
}

/**
 * Recherches que l'offre satisfait vraiment : une recherche avec rayon ne garde que les offres localisées dans
 * le rayon. Une offre sans coordonnées est gardée (on ne sait pas l'écarter).
 */
export function recherchesRetenues(noms: string[], zones: Map<string, Zone>, geo: Geo | undefined): string[] {
  return noms.filter((nom) => {
    const zone = zones.get(nom);
    if (!zone || geo?.latitude == null || geo.longitude == null) return true;
    return distanceKm(zone.centre, { latitude: geo.latitude, longitude: geo.longitude }) <= zone.rayon_km;
  });
}

const lieuDe = (c: ChampsCode): Lieu => ({
  adresse: c.adresse,
  code_postal: c.code_postal,
  commune: c.commune,
  departement: c.departement,
});

/** Ce qui est arrivé à une offre lors de l'écriture. */
type Issue = (
  | { type: 'retiree' | 'hors_zone' | 'inchangee' }
  | { type: 'nouvelle' | 'modifiee'; republication_de: string | null }
) & { id_offre: string; localisee: boolean };

const ECRITURE_VIDE: Ecriture = {
  nouvelles: [],
  modifiees: [],
  inchangees: 0,
  republications: [],
  expirees: [],
  cloturees: [],
  pages_retirees: [],
  hors_zone: [],
  a_resumer: 0,
};

/** Réducteur : cumule l'issue de chaque offre dans le bilan d'écriture. */
function cumuler(e: Ecriture, issue: Issue): Ecriture {
  switch (issue.type) {
    case 'retiree':
      return { ...e, pages_retirees: [...e.pages_retirees, issue.id_offre] };
    case 'hors_zone':
      return { ...e, hors_zone: [...e.hors_zone, issue.id_offre] };
    case 'inchangee':
      return { ...e, inchangees: e.inchangees + 1 };
    case 'nouvelle':
    case 'modifiee': {
      const liste = issue.type === 'nouvelle' ? 'nouvelles' : 'modifiees';
      const republications = issue.republication_de
        ? [...e.republications, { id_offre: issue.id_offre, republication_de: issue.republication_de }]
        : e.republications;
      return { ...e, [liste]: [...e[liste], issue.id_offre], republications, a_resumer: e.a_resumer + 1 };
    }
  }
}

interface ContexteEcriture {
  jour: string;
  dossierBrut: string;
  /** Offres en ligne aujourd'hui : une offre identique encore en ligne n'est pas une republication. */
  enLigne: Set<string>;
  geocodeur: Geocodeur;
  zones: Map<string, Zone>;
}

/** Télécharge le détail d'une offre et l'enregistre, en une transaction (un arrêt laisse les précédentes complètes). */
async function traiterOffre(depot: Depot, source: SourcePages, carte: CarteVue, ctx: ContexteEcriture): Promise<Issue> {
  const { id_offre } = carte;
  let detail: Detail;
  try {
    detail = lireDetail(await source.html(new URL(carte.url), 'lire-detail'), id_offre);
  } catch (err) {
    if (err instanceof PageAbsenteError) return { id_offre, type: 'retiree', localisee: false };
    throw err;
  }
  const champs = champsOffre(carte, detail);
  // Hors transaction : un appel réseau (le cache répond pour les lieux déjà vus).
  const geo = await ctx.geocodeur.lieu(lieuDe(champs));
  const localisee = geo?.latitude != null;
  const recherches = recherchesRetenues(carte.recherches, ctx.zones, geo);
  if (!recherches.length) return { id_offre, type: 'hors_zone', localisee };
  return depot.transaction((): Issue => {
    const evolution = depot.enregistrerOffre(champs, ctx.jour);
    // Géocodeur en panne : les coordonnées déjà connues sont gardées.
    if (geo) depot.poserGeo(id_offre, geo);
    recherches.forEach((nom) => depot.lierRecherche(nom, id_offre));
    if (evolution === 'inchangee') return { id_offre, type: 'inchangee', localisee };
    const origine =
      evolution === 'nouvelle' && champs.empreinte_identite
        ? depot.trouverRepublication(champs.empreinte_identite, id_offre)
        : undefined;
    const republication_de = origine && !ctx.enLigne.has(origine) ? origine : null;
    if (republication_de) depot.marquerRepublication(id_offre, republication_de);
    depot.ajouterAResumer(id_offre, evolution, ecrireTexteBrut(ctx.dossierBrut, id_offre, detail.texte_brut), ctx.jour);
    return { id_offre, type: evolution, republication_de, localisee };
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
  const issues: Issue[] = [];
  // Séquentiel : le délai de politesse entre deux pages du site est imposé par http.ts.
  for (const carte of bilan.cartes) issues.push(await traiterOffre(depot, source, carte, ctx));
  const absents = issues.filter((i) => i.type === 'retiree').length;
  // Avant de compter les absences : une casse ne doit faire expirer aucune offre.
  if (issues.length >= MIN_DETAILS_CONTROLES && absents / issues.length > PART_DETAILS_ABSENTS) {
    throw new CasseError(
      'lire-detail',
      `${absents} pages détail sur ${issues.length} introuvables (404) : format des liens d'offre changé ?`,
    );
  }
  if (bilan.absentes) depot.noterAbsences(bilan.absentes);
  const enregistrees = issues.filter((i) => i.type !== 'retiree' && i.type !== 'hors_zone');
  return {
    ecriture: {
      ...issues.reduce(cumuler, ECRITURE_VIDE),
      expirees: bilan.absentes ? depot.expirer(SEUIL_EXPIRATION) : [],
      cloturees: depot.cloturer(ctx.jour),
    },
    non_localisees: enregistrees.filter((i) => !i.localisee).length,
  };
}

function formaterGeo(g: BilanGeo): string[] {
  const lignes = [`Géocodage : ${g.appels} appel(s), ${g.non_localisees} offre(s) sans coordonnées`];
  if (g.panne) lignes.push(`  géocodeur en panne (repris au prochain passage) : ${g.panne}`);
  if (g.rayons_ignores.length) lignes.push(`  rayon non appliqué aujourd'hui : ${g.rayons_ignores.join(', ')}`);
  return lignes;
}

/** Bilan lisible (terminal, tâche planifiée). */
export function formaterBilan(b: BilanCollecte): string {
  const lignes = ['Recherches :'];
  for (const r of b.recherches) {
    const ecart = r.ecartees ? `, ${r.ecartees} écartée(s) par le versant` : '';
    const plafond = r.tronquee ? ' — PLAFOND ATTEINT, résultats tronqués' : '';
    lignes.push(`  ${r.nom} : ${r.total} annoncée(s), ${r.pages} page(s) lue(s)${ecart}${plafond}`);
  }
  const absentes = b.absentes === null ? `non comptées (${b.partielle})` : String(b.absentes.length);
  const parId = new Map(b.cartes.map((c) => [c.id_offre, c]));
  const offre = (id: string) => {
    const c = parId.get(id)!;
    return [
      `  ${c.titre} — ${c.employeur ?? '?'} — ${c.localisation ?? '?'} — ${c.date_publication ?? '?'}`,
      `    ${c.url}`,
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
    `  absentes : ${absentes}`,
    `  expirées : ${e.expirees.length}`,
    `  clôturées (date limite passée) : ${e.cloturees.length}`,
    `  hors du rayon (ignorées) : ${e.hors_zone.length}`,
    `À résumer : ${e.a_resumer}`,
  );
  if (b.geo) lignes.push(...formaterGeo(b.geo));
  lignes.push(b.trajets ? formaterTrajets(b.trajets) : 'Trajets : non calculés (CSP_ORIGINE_TRAJET vide)');
  if (e.nouvelles.length) lignes.push('', 'Nouvelles :', ...e.nouvelles.flatMap(offre));
  if (e.modifiees.length) lignes.push('', 'Modifiées :', ...e.modifiees.flatMap(offre));
  return lignes.join('\n');
}
