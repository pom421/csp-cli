// `csp purge` (PLAN §4) : textes bruts orphelins ou d'offres disparues depuis plus de 30 jours, vieux diagnostics.
// Ne touche qu'aux fichiers qu'il reconnaît (noms produits par le code), dans les dossiers du projet.
import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { chemins } from './config.ts';
import { Depot } from './db/depot.ts';

/** Ancienneté au-delà de laquelle textes bruts d'offres disparues et diagnostics sont supprimés. */
export const DUREE_CONSERVATION_JOURS = 30;

const TEXTE_BRUT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.txt$/;
const JOUR = /^\d{4}-\d{2}-\d{2}$/;

export interface BilanPurge {
  /** Offres disparues retirées de la file, avec leur texte brut. */
  file: string[];
  /** Textes bruts que la file ne référence plus. */
  orphelins: string[];
  /** Dossiers de diagnostics (un par jour) supprimés. */
  diagnostics: string[];
  /** --dry-run : rien n'est supprimé. */
  apercu: boolean;
}

/** Jour (AAAA-MM-JJ) `jours` avant `jour`. */
export function joursAvant(jour: string, jours: number): string {
  const d = new Date(`${jour}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - jours);
  return d.toISOString().slice(0, 10);
}

const fichiers = (dossier: string) => (existsSync(dossier) ? readdirSync(dossier) : []);

export function purge(options: {
  jour: string;
  dryRun?: boolean;
  base?: string;
  dossierBrut?: string;
  dossierDiagnostics?: string;
}): BilanPurge {
  const c = chemins();
  const dossierBrut = options.dossierBrut ?? c.brut;
  const dossierDiagnostics = options.dossierDiagnostics ?? c.diagnostics;
  const limite = joursAvant(options.jour, DUREE_CONSERVATION_JOURS);
  const supprimer = (chemin: string) => {
    if (!options.dryRun) rmSync(chemin, { recursive: true, force: true });
  };

  const depot = new Depot(options.base ?? c.base, { lectureSeule: Boolean(options.dryRun) });
  let file: string[];
  let references: Set<string>;
  try {
    const perimes = depot.aResumerPerimes(limite);
    for (const p of perimes) {
      if (!options.dryRun) depot.retirerAResumer(p.id_offre);
    }
    file = perimes.map((p) => p.id_offre);
    const gardes = depot.aResumer().filter((a) => !file.includes(a.id_offre));
    // Par nom de fichier : un même dossier peut s'écrire de deux façons (lien symbolique, CSP_HOME relatif).
    references = new Set(gardes.map((a) => basename(a.chemin_brut)));
  } finally {
    depot.fermer();
  }

  // Fichiers ordinaires au nom attendu seulement : un lien symbolique ou un fichier inconnu n'est jamais suivi ni effacé.
  const orphelins = fichiers(dossierBrut).filter((nom) => {
    const chemin = join(dossierBrut, nom);
    return TEXTE_BRUT.test(nom) && lstatSync(chemin).isFile() && !references.has(nom);
  });
  orphelins.forEach((nom) => supprimer(join(dossierBrut, nom)));

  const diagnostics = fichiers(dossierDiagnostics).filter(
    (nom) => JOUR.test(nom) && nom < limite && lstatSync(join(dossierDiagnostics, nom)).isDirectory(),
  );
  diagnostics.forEach((nom) => supprimer(join(dossierDiagnostics, nom)));

  return { file, orphelins, diagnostics, apercu: Boolean(options.dryRun) };
}

export function formaterPurge(b: BilanPurge): string {
  const verbe = b.apercu ? 'à supprimer (aperçu, rien n’est supprimé)' : 'supprimé(s)';
  return [
    `Offres disparues retirées de la file : ${b.file.length}`,
    `Textes bruts orphelins ${verbe} : ${b.orphelins.length}`,
    `Diagnostics de plus de ${DUREE_CONSERVATION_JOURS} jours ${verbe} : ${b.diagnostics.length}`,
  ].join('\n');
}
