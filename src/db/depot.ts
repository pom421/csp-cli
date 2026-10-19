// Accès à la base : requêtes paramétrées uniquement. Les seuls noms de colonnes interpolés dans le SQL
// viennent des listes constantes ci-dessous, jamais d'une donnée.
import { chmodSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { UserError } from '../erreurs.ts';
import { dossierPrive, MODE_FICHIER } from '../securite/fichiers.ts';
import { migrer } from './migrations.ts';
import type { ChampsCode, ChampsResume, Execution, Offre, PrecisionGeo } from './schema.ts';

const COLONNES_CODE = [
  'id_offre',
  'url',
  'titre',
  'employeur',
  'versant',
  'categorie',
  'type_contrat',
  'temps_travail',
  'metier',
  'domaine',
  'adresse',
  'commune',
  'code_postal',
  'departement',
  'latitude',
  'longitude',
  'precision_geo',
  'date_publication',
  'date_limite_candidature',
  'empreinte_carte',
  'empreinte_detail',
  'empreinte_identite',
] as const satisfies readonly (keyof ChampsCode)[];

/**
 * Colonnes que le code ne remplace pas par `null` : type de contrat et temps de travail peuvent venir du résumé
 * (PLAN §10 « code, sinon LLM ») ; l'empreinte du détail reste celle du dernier téléchargement réussi.
 */
const CONSERVEES_SI_NULL = new Set<string>(['type_contrat', 'temps_travail', 'empreinte_detail']);

const COLONNES_RESUME = [
  'resume',
  'points_attention',
  'competences',
  'duree_contrat_mois',
  'teletravail_jours_semaine',
  'remuneration_min',
  'remuneration_max',
  'remuneration_texte',
  'management',
  'taille_equipe',
  'experience_annees_min',
  'niveau_diplome',
  'date_prise_poste',
] as const satisfies readonly (keyof ChampsResume)[];

export type Evolution = 'nouvelle' | 'modifiee' | 'inchangee';

/** Valeur JS → valeur SQLite : booléen en 0/1, tableau en JSON, undefined en NULL. */
function sql(v: unknown): SQLInputValue {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (Array.isArray(v)) return JSON.stringify(v);
  if (typeof v === 'string' || typeof v === 'number') return v;
  throw new TypeError(`Valeur non enregistrable : ${typeof v}`);
}

type Ligne = Record<string, SQLInputValue>;

function versOffre(l: Ligne): Offre {
  const json = (v: SQLInputValue) => (typeof v === 'string' ? (JSON.parse(v) as string[]) : null);
  return {
    ...(l as unknown as Offre),
    management: l.management === null ? null : l.management === 1,
    competences: json(l.competences),
    points_attention: json(l.points_attention),
  };
}

export class Depot {
  readonly db: DatabaseSync;

  constructor(chemin: string) {
    if (chemin !== ':memory:') dossierPrive(dirname(chemin));
    this.db = new DatabaseSync(chemin);
    if (chemin !== ':memory:') {
      chmodSync(chemin, MODE_FICHIER);
      this.db.exec('PRAGMA journal_mode = WAL');
    }
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    migrer(this.db);
    // Fichiers annexes du mode WAL : mêmes droits que la base (le umask du CLI les protège déjà).
    for (const annexe of [`${chemin}-wal`, `${chemin}-shm`]) if (existsSync(annexe)) chmodSync(annexe, MODE_FICHIER);
  }

  fermer(): void {
    this.db.close();
  }

  private profondeur = 0;

  /**
   * Exécute `fn` dans une transaction : tout ou rien (une offre = une transaction pendant la collecte).
   * Imbricable : un point de sauvegarde par niveau, nommé d'après la profondeur (jamais d'une donnée).
   */
  transaction<T>(fn: () => T): T {
    const nom = `sp${this.profondeur++}`;
    this.db.exec(`SAVEPOINT ${nom}`);
    try {
      const r = fn();
      this.db.exec(`RELEASE ${nom}`);
      return r;
    } catch (e) {
      this.db.exec(`ROLLBACK TO ${nom}; RELEASE ${nom}`);
      throw e;
    } finally {
      this.profondeur--;
    }
  }

  // ── Offres ────────────────────────────────────────────────────────────────

  obtenirOffre(id: string): Offre | undefined {
    const l = this.db.prepare('SELECT * FROM offres WHERE id_offre = ?').get(id) as Ligne | undefined;
    return l && versOffre(l);
  }

  offres(statut?: Offre['statut']): Offre[] {
    const lignes = statut
      ? this.db.prepare('SELECT * FROM offres WHERE statut = ? ORDER BY id_offre').all(statut)
      : this.db.prepare('SELECT * FROM offres ORDER BY id_offre').all();
    return (lignes as Ligne[]).map(versOffre);
  }

  /**
   * Insère ou met à jour les champs posés par le code. L'offre est marquée vue ce jour (absences remises à 0,
   * une offre expirée qui réapparaît redevient active). Renvoie l'évolution selon `empreinte_detail`.
   */
  enregistrerOffre(champs: ChampsCode, date: string): Evolution {
    return this.transaction(() => {
      const avant = this.db.prepare('SELECT empreinte_detail FROM offres WHERE id_offre = ?').get(champs.id_offre) as
        | { empreinte_detail: string | null }
        | undefined;
      const modifiee =
        avant !== undefined && champs.empreinte_detail !== null && champs.empreinte_detail !== avant.empreinte_detail;
      const valeurs: Ligne = Object.fromEntries(COLONNES_CODE.map((c) => [c, sql(champs[c])]));
      const misesAJour = COLONNES_CODE.filter((c) => c !== 'id_offre').map((c) =>
        CONSERVEES_SI_NULL.has(c) ? `${c} = coalesce(excluded.${c}, offres.${c})` : `${c} = excluded.${c}`,
      );
      this.db
        .prepare(
          `INSERT INTO offres (${COLONNES_CODE.join(', ')}, date_premiere_vue, date_derniere_vue, date_maj_detail)
           VALUES (${COLONNES_CODE.map((c) => `:${c}`).join(', ')}, :date, :date, :date_maj)
           ON CONFLICT (id_offre) DO UPDATE SET
             ${misesAJour.join(',\n             ')},
             date_derniere_vue = excluded.date_derniere_vue,
             date_maj_detail = coalesce(:date_maj, offres.date_maj_detail),
             absences_consecutives = 0,
             statut = CASE WHEN offres.statut = 'expiree' THEN 'active' ELSE offres.statut END`,
        )
        .run({
          ...valeurs,
          date,
          date_maj: avant === undefined || modifiee ? (champs.empreinte_detail === null ? null : date) : null,
        });
      return avant === undefined ? 'nouvelle' : modifiee ? 'modifiee' : 'inchangee';
    });
  }

  /** +1 absence pour les offres actives ou clôturées non vues lors d'une collecte complète. */
  noterAbsences(ids: readonly string[]): void {
    const stmt = this.db.prepare(
      "UPDATE offres SET absences_consecutives = absences_consecutives + 1 WHERE id_offre = ? AND statut != 'expiree'",
    );
    this.transaction(() => ids.forEach((id) => stmt.run(id)));
  }

  /** Passe en `expiree` les offres absentes `seuil` fois de suite ; renvoie leurs identifiants. */
  expirer(seuil = 3): string[] {
    const lignes = this.db
      .prepare(
        "UPDATE offres SET statut = 'expiree' WHERE statut != 'expiree' AND absences_consecutives >= ? RETURNING id_offre",
      )
      .all(seuil) as { id_offre: string }[];
    return lignes.map((l) => l.id_offre).sort();
  }

  /** Offre active dont la date limite (ISO) est passée : `cloturee` ; renvoie leurs identifiants. */
  cloturer(aujourdhui: string): string[] {
    const lignes = this.db
      .prepare(
        "UPDATE offres SET statut = 'cloturee' WHERE statut = 'active' AND date_limite_candidature < ? RETURNING id_offre",
      )
      .all(aujourdhui) as { id_offre: string }[];
    return lignes.map((l) => l.id_offre).sort();
  }

  /** Offre antérieure de même identité (titre + employeur + commune) sous un autre identifiant. */
  trouverRepublication(empreinteIdentite: string, idOffre: string): string | undefined {
    const l = this.db
      .prepare(
        `SELECT id_offre FROM offres WHERE empreinte_identite = ? AND id_offre != ?
         ORDER BY date_premiere_vue DESC, id_offre DESC LIMIT 1`,
      )
      .get(empreinteIdentite, idOffre) as { id_offre: string } | undefined;
    return l?.id_offre;
  }

  marquerRepublication(idOffre: string, idOrigine: string): void {
    this.db.prepare('UPDATE offres SET republication_de = ? WHERE id_offre = ?').run(idOrigine, idOffre);
  }

  lierRecherche(nomRecherche: string, idOffre: string): void {
    this.db
      .prepare('INSERT INTO recherches_offres (nom_recherche, id_offre) VALUES (?, ?) ON CONFLICT DO NOTHING')
      .run(nomRecherche, idOffre);
  }

  recherchesDe(idOffre: string): string[] {
    const lignes = this.db
      .prepare('SELECT nom_recherche FROM recherches_offres WHERE id_offre = ? ORDER BY nom_recherche')
      .all(idOffre) as { nom_recherche: string }[];
    return lignes.map((l) => l.nom_recherche);
  }

  // ── Résumés ───────────────────────────────────────────────────────────────

  ajouterAResumer(idOffre: string, raison: 'nouvelle' | 'modifiee', cheminBrut: string, date: string): void {
    this.db
      .prepare(
        `INSERT INTO a_resumer (id_offre, raison, chemin_brut, date) VALUES (?, ?, ?, ?)
         ON CONFLICT (id_offre) DO UPDATE SET chemin_brut = excluded.chemin_brut, date = excluded.date,
           raison = CASE WHEN a_resumer.raison = 'nouvelle' THEN 'nouvelle' ELSE excluded.raison END`,
      )
      .run(idOffre, raison, cheminBrut, date);
  }

  aResumer(): { id_offre: string; raison: 'nouvelle' | 'modifiee'; chemin_brut: string; date: string }[] {
    return this.db.prepare('SELECT * FROM a_resumer ORDER BY date, id_offre').all() as ReturnType<Depot['aResumer']>;
  }

  /** Écrit les champs du résumé et retire l'offre de la file, en une transaction. */
  enregistrerResume(idOffre: string, r: ChampsResume, date: string): void {
    this.transaction(() => {
      const valeurs: Ligne = Object.fromEntries(COLONNES_RESUME.map((c) => [c, sql(r[c])]));
      const res = this.db
        .prepare(
          `UPDATE offres SET ${COLONNES_RESUME.map((c) => `${c} = :${c}`).join(', ')},
             type_contrat = coalesce(type_contrat, :type_contrat),
             temps_travail = coalesce(temps_travail, :temps_travail),
             date_resume = :date
           WHERE id_offre = :id_offre`,
        )
        .run({
          ...valeurs,
          type_contrat: sql(r.type_contrat),
          temps_travail: sql(r.temps_travail),
          date,
          id_offre: idOffre,
        });
      if (res.changes === 0) throw new UserError(`Offre inconnue : ${idOffre}`);
      this.db.prepare('DELETE FROM a_resumer WHERE id_offre = ?').run(idOffre);
    });
  }

  // ── Caches géographiques ──────────────────────────────────────────────────

  lireGeocodage(cleLieu: string) {
    return this.db.prepare('SELECT * FROM geocodage_cache WHERE cle_lieu = ?').get(cleLieu) as
      | {
          cle_lieu: string;
          latitude: number;
          longitude: number;
          precision_geo: PrecisionGeo;
          source: string;
          date: string;
        }
      | undefined;
  }

  ecrireGeocodage(g: {
    cle_lieu: string;
    latitude: number;
    longitude: number;
    precision_geo: PrecisionGeo;
    source: string;
    date: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO geocodage_cache (cle_lieu, latitude, longitude, precision_geo, source, date)
         VALUES (:cle_lieu, :latitude, :longitude, :precision_geo, :source, :date)
         ON CONFLICT (cle_lieu) DO UPDATE SET latitude = excluded.latitude, longitude = excluded.longitude,
           precision_geo = excluded.precision_geo, source = excluded.source, date = excluded.date`,
      )
      .run(g);
  }

  lireTrajet(cleOrigine: string, cleDestination: string, heureRef: string) {
    return this.db
      .prepare('SELECT * FROM trajets_cache WHERE cle_origine = ? AND cle_destination = ? AND heure_ref = ?')
      .get(cleOrigine, cleDestination, heureRef) as
      | { duree_min: number | null; nb_correspondances: number | null; date: string }
      | undefined;
  }

  /** `duree_min` null = aucun itinéraire trouvé (mis en cache aussi, pour ne pas redemander chaque jour). */
  ecrireTrajet(t: {
    cle_origine: string;
    cle_destination: string;
    heure_ref: string;
    duree_min: number | null;
    nb_correspondances: number | null;
    date: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO trajets_cache (cle_origine, cle_destination, heure_ref, duree_min, nb_correspondances, date)
         VALUES (:cle_origine, :cle_destination, :heure_ref, :duree_min, :nb_correspondances, :date)
         ON CONFLICT (cle_origine, cle_destination, heure_ref) DO UPDATE SET duree_min = excluded.duree_min,
           nb_correspondances = excluded.nb_correspondances, date = excluded.date`,
      )
      .run(t);
  }

  /** Vide le cache de trajets (changement d'adresse de départ : `csp trajets --recalculer`). */
  viderTrajets(): number {
    return Number(this.db.prepare('DELETE FROM trajets_cache').run().changes);
  }

  // ── Exécutions ────────────────────────────────────────────────────────────

  commencerExecution(debut: string): number {
    return Number(this.db.prepare('INSERT INTO executions (debut) VALUES (?)').run(debut).lastInsertRowid);
  }

  terminerExecution(
    id: number,
    fin: Pick<Execution, 'fin' | 'statut' | 'code_sortie'> &
      Partial<Pick<Execution, 'nb_cartes' | 'nb_nouvelles' | 'nb_modifiees' | 'nb_expirees' | 'message'>>,
  ): void {
    this.db
      .prepare(
        `UPDATE executions SET fin = :fin, statut = :statut, code_sortie = :code_sortie, nb_cartes = :nb_cartes,
           nb_nouvelles = :nb_nouvelles, nb_modifiees = :nb_modifiees, nb_expirees = :nb_expirees, message = :message
         WHERE id = :id`,
      )
      .run({
        id,
        fin: fin.fin,
        statut: fin.statut,
        code_sortie: fin.code_sortie,
        nb_cartes: sql(fin.nb_cartes),
        nb_nouvelles: sql(fin.nb_nouvelles),
        nb_modifiees: sql(fin.nb_modifiees),
        nb_expirees: sql(fin.nb_expirees),
        message: sql(fin.message),
      });
  }

  derniereExecution(): Execution | undefined {
    return this.db.prepare('SELECT * FROM executions ORDER BY id DESC LIMIT 1').get() as Execution | undefined;
  }
}
