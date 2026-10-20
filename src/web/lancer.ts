// `csp web` : ouvre la base en lecture seule et sert l'application jusqu'à Ctrl+C.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { jourParis } from '../collecte.ts';
import { chemins, heureDepart, lireRecherches } from '../config.ts';
import { Depot } from '../db/depot.ts';
import { UserError } from '../erreurs.ts';
import type { RechercheWeb } from './contrat.ts';
import { demarrerWeb, DOSSIER_APPLICATION } from './serveur.ts';

/** Recherches du fichier ; s'il manque ou est invalide, l'application s'ouvre quand même, sans trajets. */
function recherches(): { recherches: RechercheWeb[]; avertissement: string | null } {
  try {
    return { recherches: lireRecherches().map((r) => ({ nom: r.nom, depart: r.depart ?? null })), avertissement: null };
  } catch (e) {
    if (!(e instanceof UserError)) throw e;
    return { recherches: [], avertissement: e.message.split('\n')[0] };
  }
}

export async function lancerWeb(port: number): Promise<void> {
  const base = chemins().base;
  if (!existsSync(base)) throw new UserError(`Base absente (${base}) : lancez d'abord csp collecte.`);
  if (!existsSync(join(DOSSIER_APPLICATION, 'index.html'))) {
    throw new UserError(`Application non compilée (${DOSSIER_APPLICATION}) : lancez vp run web:build.`);
  }
  const depot = new Depot(base, { lectureSeule: true });
  try {
    const serveur = await demarrerWeb({
      port,
      source: { depot, heure: heureDepart(), aujourdhui: () => jourParis(new Date()), ...recherches() },
    }).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'EADDRINUSE') throw new UserError(`Port ${port} déjà utilisé : choisir un autre avec --port.`);
      throw e;
    });
    console.log(`Offres : ${serveur.url}  (lecture seule, Ctrl+C pour arrêter)`);
    await new Promise<void>((fin) => {
      process.once('SIGINT', fin);
      process.once('SIGTERM', fin);
    });
    await serveur.fermer();
  } finally {
    depot.fermer();
  }
}
