// Fichiers locaux (base, textes bruts, diagnostics, .env) : lisibles par l'utilisateur seul.
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';

export const MODE_DOSSIER = 0o700;
export const MODE_FICHIER = 0o600;

/** Crée le dossier (et ses parents) en 0700 ; corrige les droits s'il existait déjà. */
export function dossierPrive(chemin: string): void {
  mkdirSync(chemin, { recursive: true, mode: MODE_DOSSIER });
  chmodSync(chemin, MODE_DOSSIER);
}

/** Écrit un fichier en 0600 ; `mode` est ignoré si le fichier existe, d'où le chmod explicite. */
export function ecrireFichierPrive(chemin: string, contenu: string | Uint8Array): void {
  writeFileSync(chemin, contenu, { mode: MODE_FICHIER });
  chmodSync(chemin, MODE_FICHIER);
}

/** Droits ouverts au groupe ou aux autres, ou `undefined` si le chemin n'existe pas. */
export function droitsTropOuverts(chemin: string): number | undefined {
  if (!existsSync(chemin)) return undefined;
  return statSync(chemin).mode & 0o077;
}

export const droits = (chemin: string) => (statSync(chemin).mode & 0o777).toString(8);
