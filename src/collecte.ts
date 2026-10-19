// Collecte quotidienne (PLAN §4) : recherches → cartes → détail de chaque offre → base, file « à résumer ».
// --dry-run : liste seule, comparée à la base ouverte en lecture seule, rien n'est écrit ni téléchargé au-delà des listes.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { chemins, lireRecherches, type Recherche } from './config.ts';
import { Depot } from './db/depot.ts';
import type { ChampsCode } from './db/schema.ts';
import { codeDeSortie, UserError } from './erreurs.ts';
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
  a_resumer: number;
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
}

export interface OptionsCollecte {
  dryRun: boolean;
  recherche?: string;
  source?: SourcePages;
  base?: string;
  dossierBrut?: string;
  recherches?: Recherche[];
  maintenant?: () => Date;
}

/** Date du jour à Paris (AAAA-MM-JJ), quel que soit le fuseau de la machine. */
export const jourParis = (d: Date) => d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });

/** Dédoublonne les cartes de toutes les recherches en gardant la liste des recherches de chaque offre. */
export function fusionner(resultats: ResultatRecherche[]): BilanCollecte['cartes'] {
  const parId = new Map<string, Carte & { recherches: string[] }>();
  for (const r of resultats) {
    for (const c of r.cartes) {
      const deja = parId.get(c.id_offre);
      if (deja) {
        if (!deja.recherches.includes(r.nom)) deja.recherches.push(r.nom);
      } else {
        parId.set(c.id_offre, { ...c, recherches: [r.nom] });
      }
    }
  }
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
    latitude: null,
    longitude: null,
    precision_geo: null,
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

export async function collecte(options: OptionsCollecte): Promise<BilanCollecte> {
  let recherches = options.recherches ?? lireRecherches();
  if (options.recherche) {
    recherches = recherches.filter((r) => r.nom === options.recherche);
    if (!recherches.length) throw new UserError(`Recherche inconnue : ${options.recherche}`);
  }
  const source = options.source ?? sourceHttp;
  const maintenant = options.maintenant ?? (() => new Date());
  const base = options.base ?? chemins().base;

  if (options.dryRun) {
    const resultats = await parcourirToutes(source, recherches);
    const enBase = new Map<string, string>();
    if (existsSync(base)) {
      const depot = new Depot(base, { lectureSeule: true });
      try {
        for (const o of depot.listerOffres()) enBase.set(o.id_offre, o.statut);
      } finally {
        depot.fermer();
      }
    }
    return { ...comparer(resultats, enBase, options.recherche), ecriture: null };
  }

  const depot = new Depot(base);
  const execution = depot.commencerExecution(maintenant().toISOString());
  try {
    const resultats = await parcourirToutes(source, recherches);
    const enBase = new Map(depot.listerOffres().map((o) => [o.id_offre, o.statut] as const));
    const bilan = comparer(resultats, enBase, options.recherche);
    const ecriture = await ecrire(depot, source, bilan, {
      jour: jourParis(maintenant()),
      dossierBrut: options.dossierBrut ?? chemins().brut,
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
    return { ...bilan, ecriture };
  } catch (e) {
    depot.terminerExecution(execution, {
      fin: maintenant().toISOString(),
      statut: 'echec',
      code_sortie: codeDeSortie(e),
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

function comparer(
  resultats: ResultatRecherche[],
  enBase: Map<string, string>,
  rechercheUnique: string | undefined,
): Omit<BilanCollecte, 'ecriture'> {
  const cartes = fusionner(resultats);
  const vus = new Set(cartes.map((c) => c.id_offre));
  const tronquees = resultats.filter((r) => r.tronquee).map((r) => r.nom);
  const partielle = rechercheUnique
    ? `une seule recherche lancée (${rechercheUnique})`
    : tronquees.length
      ? `plafond de pages atteint : ${tronquees.join(', ')}`
      : null;
  return {
    recherches: resultats.map(({ cartes: _c, ...r }) => r),
    cartes,
    nouvelles: cartes.filter((c) => !enBase.has(c.id_offre)).map((c) => c.id_offre),
    connues: cartes
      .filter((c) => enBase.has(c.id_offre) && enBase.get(c.id_offre) !== 'expiree')
      .map((c) => c.id_offre),
    reapparues: cartes.filter((c) => enBase.get(c.id_offre) === 'expiree').map((c) => c.id_offre),
    absentes: partielle
      ? null
      : [...enBase]
          .filter(([id, statut]) => statut !== 'expiree' && !vus.has(id))
          .map(([id]) => id)
          .sort(),
    partielle,
  };
}

async function ecrire(
  depot: Depot,
  source: SourcePages,
  bilan: Omit<BilanCollecte, 'ecriture'>,
  { jour, dossierBrut }: { jour: string; dossierBrut: string },
): Promise<Ecriture> {
  const e: Ecriture = {
    nouvelles: [],
    modifiees: [],
    inchangees: 0,
    republications: [],
    expirees: [],
    cloturees: [],
    pages_retirees: [],
    a_resumer: 0,
  };
  const enLigne = new Set(bilan.cartes.map((c) => c.id_offre));
  for (const carte of bilan.cartes) {
    let detail: Detail;
    try {
      detail = lireDetail(await source.html(new URL(carte.url), 'lire-detail'), carte.id_offre);
    } catch (err) {
      if (!(err instanceof PageAbsenteError)) throw err;
      e.pages_retirees.push(carte.id_offre);
      continue;
    }
    const champs = champsOffre(carte, detail);
    // Une offre = une transaction : un arrêt au milieu laisse les offres précédentes complètes.
    depot.transaction(() => {
      const evolution = depot.enregistrerOffre(champs, jour);
      for (const nom of carte.recherches) depot.lierRecherche(nom, carte.id_offre);
      if (evolution === 'inchangee') {
        e.inchangees++;
        return;
      }
      (evolution === 'nouvelle' ? e.nouvelles : e.modifiees).push(carte.id_offre);
      if (evolution === 'nouvelle' && champs.empreinte_identite) {
        // Deux postes identiques en ligne le même jour ne sont pas une republication : l'origine doit avoir disparu.
        const origine = depot.trouverRepublication(champs.empreinte_identite, carte.id_offre);
        if (origine && !enLigne.has(origine)) {
          depot.marquerRepublication(carte.id_offre, origine);
          e.republications.push({ id_offre: carte.id_offre, republication_de: origine });
        }
      }
      if (!NOM_SUR.test(carte.id_offre)) throw new UserError(`Identifiant inattendu : ${carte.id_offre}`);
      dossierPrive(dossierBrut);
      const chemin = join(dossierBrut, `${carte.id_offre}.txt`);
      ecrireFichierPrive(chemin, `${detail.texte_brut}\n`);
      depot.ajouterAResumer(carte.id_offre, evolution, chemin, jour);
      e.a_resumer++;
    });
  }
  if (bilan.absentes) {
    depot.noterAbsences(bilan.absentes);
    e.expirees = depot.expirer(SEUIL_EXPIRATION);
  }
  e.cloturees = depot.cloturer(jour);
  return e;
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
    `À résumer : ${e.a_resumer}`,
  );
  if (e.nouvelles.length) lignes.push('', 'Nouvelles :', ...e.nouvelles.flatMap(offre));
  if (e.modifiees.length) lignes.push('', 'Modifiées :', ...e.modifiees.flatMap(offre));
  return lignes.join('\n');
}
