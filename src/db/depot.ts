// Accès à la base via Drizzle (requêtes paramétrées par construction) sur node:sqlite.
import { chmodSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { and, asc, desc, eq, gte, lt, ne, sql } from 'drizzle-orm';
import { drizzle, type NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { migrate } from 'drizzle-orm/node-sqlite/migrator';
import { UserError } from '../erreurs.ts';
import { dossierPrive, MODE_FICHIER } from '../securite/fichiers.ts';
import {
  a_resumer,
  executions,
  geocodage_cache,
  offres,
  recherches_offres,
  trajets_cache,
  type ChampsCode,
  type ChampsResume,
  type Execution,
  type Geocodage,
  type Offre,
  type Trajet,
} from './schema.ts';

export const DOSSIER_MIGRATIONS = new URL('../../drizzle', import.meta.url).pathname;

export type Evolution = 'nouvelle' | 'modifiee' | 'inchangee';

/** Valeur de la ligne proposée à l'insertion (`excluded.colonne`) dans un ON CONFLICT DO UPDATE. */
const proposee = (colonne: string) => sql.raw(`excluded.${colonne}`);

export class Depot {
  readonly client: DatabaseSync;
  readonly db: NodeSQLiteDatabase;

  /** `lectureSeule` : aucune écriture, ni migration (collecte --dry-run). La base doit exister. */
  constructor(chemin: string, { lectureSeule = false } = {}) {
    const memoire = chemin === ':memory:';
    if (lectureSeule) {
      this.client = new DatabaseSync(chemin, { readOnly: true });
      this.db = drizzle({ client: this.client });
      return;
    }
    if (!memoire) dossierPrive(dirname(chemin));
    this.client = new DatabaseSync(chemin);
    if (!memoire) {
      chmodSync(chemin, MODE_FICHIER);
      this.client.exec('PRAGMA journal_mode = WAL');
    }
    this.client.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.db = drizzle({ client: this.client });
    migrate(this.db, { migrationsFolder: DOSSIER_MIGRATIONS });
    // Fichiers annexes du mode WAL : mêmes droits que la base (le umask du CLI les protège déjà).
    for (const annexe of [`${chemin}-wal`, `${chemin}-shm`]) if (existsSync(annexe)) chmodSync(annexe, MODE_FICHIER);
  }

  fermer(): void {
    this.client.close();
  }

  private profondeur = 0;

  /**
   * Exécute `fn` dans une transaction : tout ou rien (une offre = une transaction pendant la collecte).
   * Imbricable : un point de sauvegarde par niveau, nommé d'après la profondeur (jamais d'une donnée).
   */
  transaction<T>(fn: () => T): T {
    const nom = `sp${this.profondeur++}`;
    this.client.exec(`SAVEPOINT ${nom}`);
    try {
      const r = fn();
      this.client.exec(`RELEASE ${nom}`);
      return r;
    } catch (e) {
      this.client.exec(`ROLLBACK TO ${nom}; RELEASE ${nom}`);
      throw e;
    } finally {
      this.profondeur--;
    }
  }

  // ── Offres ────────────────────────────────────────────────────────────────

  obtenirOffre(id: string): Offre | undefined {
    return this.db.select().from(offres).where(eq(offres.id_offre, id)).get();
  }

  listerOffres(statut?: Offre['statut']): Offre[] {
    return this.db
      .select()
      .from(offres)
      .where(statut ? eq(offres.statut, statut) : undefined)
      .orderBy(asc(offres.id_offre))
      .all();
  }

  /**
   * Insère ou met à jour les champs posés par le code. L'offre est marquée vue ce jour (absences remises à 0,
   * une offre expirée qui réapparaît redevient active). Renvoie l'évolution selon `empreinte_detail`.
   */
  enregistrerOffre(champs: ChampsCode, date: string): Evolution {
    return this.transaction(() => {
      const avant = this.db
        .select({ empreinte_detail: offres.empreinte_detail })
        .from(offres)
        .where(eq(offres.id_offre, champs.id_offre))
        .get();
      const evolution: Evolution =
        avant === undefined
          ? 'nouvelle'
          : champs.empreinte_detail !== null && champs.empreinte_detail !== avant.empreinte_detail
            ? 'modifiee'
            : 'inchangee';
      const dateMaj = evolution === 'inchangee' || champs.empreinte_detail === null ? null : date;
      const { id_offre: _id, ...remplaces } = champs;
      this.db
        .insert(offres)
        .values({ ...champs, date_premiere_vue: date, date_derniere_vue: date, date_maj_detail: dateMaj })
        .onConflictDoUpdate({
          target: offres.id_offre,
          set: {
            ...remplaces,
            // Peuvent venir du résumé (PLAN §10 « code, sinon LLM ») ; l'empreinte reste celle du dernier détail lu.
            type_contrat: sql`coalesce(${proposee('type_contrat')}, ${offres.type_contrat})`,
            temps_travail: sql`coalesce(${proposee('temps_travail')}, ${offres.temps_travail})`,
            empreinte_detail: sql`coalesce(${proposee('empreinte_detail')}, ${offres.empreinte_detail})`,
            date_derniere_vue: date,
            date_maj_detail: sql`coalesce(${dateMaj}, ${offres.date_maj_detail})`,
            absences_consecutives: 0,
            statut: sql`CASE WHEN ${offres.statut} = 'expiree' THEN 'active' ELSE ${offres.statut} END`,
          },
        })
        .run();
      return evolution;
    });
  }

  /** +1 absence pour les offres non expirées absentes d'une collecte complète. */
  noterAbsences(ids: readonly string[]): void {
    this.transaction(() => {
      for (const id of ids) {
        this.db
          .update(offres)
          .set({ absences_consecutives: sql`${offres.absences_consecutives} + 1` })
          .where(and(eq(offres.id_offre, id), ne(offres.statut, 'expiree')))
          .run();
      }
    });
  }

  /** Passe en `expiree` les offres absentes `seuil` fois de suite ; renvoie leurs identifiants. */
  expirer(seuil = 3): string[] {
    return this.db
      .update(offres)
      .set({ statut: 'expiree' })
      .where(and(ne(offres.statut, 'expiree'), gte(offres.absences_consecutives, seuil)))
      .returning({ id: offres.id_offre })
      .all()
      .map((l) => l.id)
      .sort();
  }

  /** Offre active dont la date limite (ISO) est passée : `cloturee` ; renvoie leurs identifiants. */
  cloturer(aujourdhui: string): string[] {
    return this.db
      .update(offres)
      .set({ statut: 'cloturee' })
      .where(and(eq(offres.statut, 'active'), lt(offres.date_limite_candidature, aujourdhui)))
      .returning({ id: offres.id_offre })
      .all()
      .map((l) => l.id)
      .sort();
  }

  /** Offre antérieure de même identité (titre + employeur + commune) sous un autre identifiant. */
  trouverRepublication(empreinteIdentite: string, idOffre: string): string | undefined {
    return this.db
      .select({ id: offres.id_offre })
      .from(offres)
      .where(and(eq(offres.empreinte_identite, empreinteIdentite), ne(offres.id_offre, idOffre)))
      .orderBy(desc(offres.date_premiere_vue), desc(offres.id_offre))
      .limit(1)
      .get()?.id;
  }

  marquerRepublication(idOffre: string, idOrigine: string): void {
    this.db.update(offres).set({ republication_de: idOrigine }).where(eq(offres.id_offre, idOffre)).run();
  }

  lierRecherche(nomRecherche: string, idOffre: string): void {
    this.db
      .insert(recherches_offres)
      .values({ nom_recherche: nomRecherche, id_offre: idOffre })
      .onConflictDoNothing()
      .run();
  }

  recherchesDe(idOffre: string): string[] {
    return this.db
      .select({ nom: recherches_offres.nom_recherche })
      .from(recherches_offres)
      .where(eq(recherches_offres.id_offre, idOffre))
      .orderBy(asc(recherches_offres.nom_recherche))
      .all()
      .map((l) => l.nom);
  }

  // ── Résumés ───────────────────────────────────────────────────────────────

  ajouterAResumer(idOffre: string, raison: 'nouvelle' | 'modifiee', cheminBrut: string, date: string): void {
    this.db
      .insert(a_resumer)
      .values({ id_offre: idOffre, raison, chemin_brut: cheminBrut, date })
      .onConflictDoUpdate({
        target: a_resumer.id_offre,
        set: {
          chemin_brut: cheminBrut,
          date,
          // Une offre nouvelle jamais résumée le reste, même modifiée entre-temps.
          raison: sql`CASE WHEN ${a_resumer.raison} = 'nouvelle' THEN 'nouvelle' ELSE ${raison} END`,
        },
      })
      .run();
  }

  aResumer() {
    return this.db.select().from(a_resumer).orderBy(asc(a_resumer.date), asc(a_resumer.id_offre)).all();
  }

  /** Écrit les champs du résumé et retire l'offre de la file, en une transaction. */
  enregistrerResume(idOffre: string, r: ChampsResume, date: string): void {
    this.transaction(() => {
      const { type_contrat, temps_travail, ...champs } = r;
      const res = this.db
        .update(offres)
        .set({
          ...champs,
          type_contrat: sql`coalesce(${offres.type_contrat}, ${type_contrat ?? null})`,
          temps_travail: sql`coalesce(${offres.temps_travail}, ${temps_travail ?? null})`,
          date_resume: date,
        })
        .where(eq(offres.id_offre, idOffre))
        .run();
      if (res.changes === 0) throw new UserError(`Offre inconnue : ${idOffre}`);
      this.db.delete(a_resumer).where(eq(a_resumer.id_offre, idOffre)).run();
    });
  }

  // ── Caches géographiques ──────────────────────────────────────────────────

  lireGeocodage(cleLieu: string): Geocodage | undefined {
    return this.db.select().from(geocodage_cache).where(eq(geocodage_cache.cle_lieu, cleLieu)).get();
  }

  ecrireGeocodage(g: Geocodage): void {
    const { cle_lieu: _cle, ...reste } = g;
    this.db
      .insert(geocodage_cache)
      .values(g)
      .onConflictDoUpdate({ target: geocodage_cache.cle_lieu, set: reste })
      .run();
  }

  lireTrajet(cleOrigine: string, cleDestination: string, heureRef: string): Trajet | undefined {
    return this.db
      .select()
      .from(trajets_cache)
      .where(
        and(
          eq(trajets_cache.cle_origine, cleOrigine),
          eq(trajets_cache.cle_destination, cleDestination),
          eq(trajets_cache.heure_ref, heureRef),
        ),
      )
      .get();
  }

  ecrireTrajet(t: Trajet): void {
    this.db
      .insert(trajets_cache)
      .values(t)
      .onConflictDoUpdate({
        target: [trajets_cache.cle_origine, trajets_cache.cle_destination, trajets_cache.heure_ref],
        set: { duree_min: t.duree_min, nb_correspondances: t.nb_correspondances, date: t.date },
      })
      .run();
  }

  /** Vide le cache de trajets (changement d'adresse de départ : `csp trajets --recalculer`). */
  viderTrajets(): number {
    return Number(this.db.delete(trajets_cache).run().changes);
  }

  // ── Exécutions ────────────────────────────────────────────────────────────

  commencerExecution(debut: string): number {
    return this.db.insert(executions).values({ debut }).returning({ id: executions.id }).get()!.id;
  }

  terminerExecution(id: number, fin: Partial<Omit<Execution, 'id' | 'debut'>>): void {
    this.db.update(executions).set(fin).where(eq(executions.id, id)).run();
  }

  derniereExecution(): Execution | undefined {
    return this.db.select().from(executions).orderBy(desc(executions.id)).limit(1).get();
  }
}
