import type { DatabaseSync } from 'node:sqlite';
import { UserError } from '../erreurs.ts';
import { MIGRATIONS } from './schema.ts';

export const versionSchema = (db: DatabaseSync): number =>
  (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;

/**
 * Applique les migrations manquantes, chacune dans sa transaction avec la mise à jour de user_version :
 * un échec laisse la base dans la dernière version complète.
 */
export function migrer(db: DatabaseSync, migrations: readonly string[] = MIGRATIONS): number {
  const actuelle = versionSchema(db);
  if (actuelle > migrations.length) {
    throw new UserError(
      `Base en version ${actuelle}, plus récente que ce code (${migrations.length}) : mettez le dépôt à jour.`,
    );
  }
  for (let v = actuelle; v < migrations.length; v++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migrations[v]);
      // PRAGMA n'accepte pas de paramètre lié ; v + 1 est un entier produit par la boucle.
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return migrations.length - actuelle;
}
