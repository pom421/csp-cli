// Collecte quotidienne (PLAN §4). Phase 3 : recherches → cartes → comparaison à la base, en lecture seule (--dry-run).
// Le téléchargement du détail, les empreintes de détail et l'écriture en base arrivent en phase 4.
import { existsSync } from 'node:fs';
import { chemins, lireRecherches, type Recherche } from './config.ts';
import { Depot } from './db/depot.ts';
import { UserError } from './erreurs.ts';
import { parcourirRecherche, type Carte, type ResultatRecherche } from './scraper/liste.ts';
import { sourceHttp, type SourcePages } from './scraper/source.ts';

export interface BilanCollecte {
  recherches: Omit<ResultatRecherche, 'cartes'>[];
  /** Offres distinctes vues (une offre peut sortir dans plusieurs recherches). */
  cartes: (Carte & { recherches: string[] })[];
  nouvelles: string[];
  /** Déjà en base : le détail dira en phase 4 si elles ont changé. */
  connues: string[];
  /** Expirées en base mais de nouveau en ligne. */
  reapparues: string[];
  /** En base, non expirées, absentes aujourd'hui ; `null` si la collecte est partielle (aucune absence comptée). */
  absentes: string[] | null;
  /** Pourquoi les absences ne sont pas comptées. */
  partielle: string | null;
}

export interface OptionsCollecte {
  dryRun: boolean;
  recherche?: string;
  source?: SourcePages;
  base?: string;
  recherches?: Recherche[];
}

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

export async function collecte(options: OptionsCollecte): Promise<BilanCollecte> {
  if (!options.dryRun) {
    throw new UserError(
      "csp collecte n'écrit pas encore en base (phase 4 : détail et empreintes). Utilisez --dry-run.",
    );
  }
  let recherches = options.recherches ?? lireRecherches();
  if (options.recherche) {
    recherches = recherches.filter((r) => r.nom === options.recherche);
    if (!recherches.length) throw new UserError(`Recherche inconnue : ${options.recherche}`);
  }
  const source = options.source ?? sourceHttp;
  const resultats: ResultatRecherche[] = [];
  for (const r of recherches) resultats.push(await parcourirRecherche(source, r));
  const cartes = fusionner(resultats);

  const base = options.base ?? chemins().base;
  const enBase = new Map<string, string>();
  if (existsSync(base)) {
    const depot = new Depot(base, { lectureSeule: true });
    try {
      for (const o of depot.listerOffres()) enBase.set(o.id_offre, o.statut);
    } finally {
      depot.fermer();
    }
  }

  const vus = new Set(cartes.map((c) => c.id_offre));
  const tronquees = resultats.filter((r) => r.tronquee).map((r) => r.nom);
  const partielle = options.recherche
    ? `une seule recherche lancée (${options.recherche})`
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

/** Bilan lisible (terminal, tâche planifiée). */
export function formaterBilan(b: BilanCollecte): string {
  const lignes = ['Recherches :'];
  for (const r of b.recherches) {
    const ecart = r.ecartees ? `, ${r.ecartees} écartée(s) par le versant` : '';
    const plafond = r.tronquee ? ' — PLAFOND ATTEINT, résultats tronqués' : '';
    lignes.push(`  ${r.nom} : ${r.total} annoncée(s), ${r.pages} page(s) lue(s)${ecart}${plafond}`);
  }
  lignes.push(
    `Offres distinctes : ${b.cartes.length}`,
    `  nouvelles : ${b.nouvelles.length}`,
    `  déjà connues : ${b.connues.length}`,
    `  réapparues : ${b.reapparues.length}`,
    `  absentes : ${b.absentes === null ? `non comptées (${b.partielle})` : b.absentes.length}`,
  );
  const parId = new Map(b.cartes.map((c) => [c.id_offre, c]));
  if (b.nouvelles.length) {
    lignes.push('', 'Nouvelles :');
    for (const id of b.nouvelles) {
      const c = parId.get(id)!;
      lignes.push(`  ${c.titre} — ${c.employeur ?? '?'} — ${c.localisation ?? '?'} — ${c.date_publication ?? '?'}`);
      lignes.push(`    ${c.url}`);
    }
  }
  return lignes.join('\n');
}
