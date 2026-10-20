import { cpSync, mkdirSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { migrate } from 'drizzle-orm/node-sqlite/migrator';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { Depot, DOSSIER_MIGRATIONS } from '../db/depot.ts';
import type { ChampsCode, ChampsResume } from '../db/schema.ts';

const J1 = '2026-10-19';
const J2 = '2026-10-20';

function offre(champs: Partial<ChampsCode> = {}): ChampsCode {
  return {
    id_offre: '2026-2445380',
    url: 'https://choisirleservicepublic.gouv.fr/offre-emploi/x-reference-2026-2445380/',
    titre: 'Chargé(e) de mission recrutement et attractivité',
    employeur: 'Rectorat de Nice',
    versant: 'FPE',
    categorie: 'A',
    type_contrat: 'titulaire_ou_contractuel',
    temps_travail: null,
    metier: null,
    domaine: 'Ressources humaines',
    adresse: null,
    commune: 'Nice',
    code_postal: null,
    departement: '06',
    management: null,
    teletravail_possible: null,
    date_publication: J1,
    date_limite_candidature: '2026-11-16',
    date_prise_poste: null,
    empreinte_carte: 'c1',
    empreinte_detail: 'd1',
    empreinte_identite: 'i1',
    ...champs,
  };
}

const resume: ChampsResume = {
  resume: '- Pilotage des recrutements\n- Marque employeur',
  points_attention: ['Forte saisonnalité de juin à octobre'],
  competences: ['GRH', 'sourcing'],
  type_contrat: 'contractuel',
  duree_contrat_mois: 36,
  temps_travail: 'complet',
  teletravail_jours_semaine: 2,
  remuneration_min: 38000,
  remuneration_max: 45000,
  remuneration_texte: 'selon grille',
  management: false,
  taille_equipe: null,
  experience_annees_min: 3,
  niveau_diplome: 'Bac+3',
  date_prise_poste: null,
};

let depot: Depot;
beforeEach(() => {
  depot = new Depot(':memory:');
});
afterEach(() => depot.fermer());

describe('migrations', () => {
  it("s'appliquent une seule fois : une base rouverte garde ses données", () => {
    const chemin = join(mkdtempSync(join(tmpdir(), 'csp-')), 'csp.sqlite');
    const d1 = new Depot(chemin);
    d1.enregistrerOffre(offre(), J1);
    d1.fermer();
    const d2 = new Depot(chemin);
    expect(d2.listerOffres()).toHaveLength(1);
    const appliquees = d2.client.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get() as { n: number };
    expect(appliquees.n).toBeGreaterThan(0);
    d2.fermer();
  });

  it('gardent les données des tables liées (aucune recréation de table destructrice)', () => {
    // Une base créée par la première migration seule, avec des lignes liées, puis amenée à la dernière version.
    const dossier = mkdtempSync(join(tmpdir(), 'csp-'));
    const premiere = join(dossier, 'migrations');
    const toutes = readdirSync(DOSSIER_MIGRATIONS).sort();
    mkdirSync(join(premiere, toutes[0]), { recursive: true });
    cpSync(join(DOSSIER_MIGRATIONS, toutes[0]), join(premiere, toutes[0]), { recursive: true });
    const chemin = join(dossier, 'csp.sqlite');
    const client = new DatabaseSync(chemin);
    client.exec('PRAGMA foreign_keys = ON');
    migrate(drizzle({ client }), { migrationsFolder: premiere });
    client.exec(`INSERT INTO offres (id_offre, url, titre, date_premiere_vue, date_derniere_vue) VALUES ('X', 'u', 't', 'd', 'd');
      INSERT INTO recherches_offres VALUES ('r', 'X');
      INSERT INTO a_resumer VALUES ('X', 'nouvelle', '/brut/X.txt', 'd');`);
    client.close();
    const d = new Depot(chemin);
    expect(d.recherchesDe('X')).toEqual(['r']);
    expect(d.aResumer()).toHaveLength(1);
    expect(d.obtenirOffre('X')).toMatchObject({ teletravail_possible: null });
    d.fermer();
  });
});

describe('fichier de base', () => {
  it('crée la base en 0600 dans un dossier 0700', () => {
    const dossier = join(mkdtempSync(join(tmpdir(), 'csp-')), 'donnees');
    const d = new Depot(join(dossier, 'csp.sqlite'));
    d.enregistrerOffre(offre(), J1);
    d.fermer();
    expect(statSync(dossier).mode & 0o777).toBe(0o700);
    expect(statSync(join(dossier, 'csp.sqlite')).mode & 0o777).toBe(0o600);
  });
});

describe('offres', () => {
  it('distingue nouvelle, inchangée et modifiée selon empreinte_detail', () => {
    expect(depot.enregistrerOffre(offre(), J1)).toBe('nouvelle');
    expect(depot.enregistrerOffre(offre(), J2)).toBe('inchangee');
    expect(depot.enregistrerOffre(offre({ empreinte_detail: 'd2' }), J2)).toBe('modifiee');
    const o = depot.obtenirOffre('2026-2445380')!;
    expect(o).toMatchObject({
      date_premiere_vue: J1,
      date_derniere_vue: J2,
      date_maj_detail: J2,
      empreinte_detail: 'd2',
    });
  });

  it("garde l'empreinte précédente si le détail n'a pas pu être téléchargé", () => {
    depot.enregistrerOffre(offre(), J1);
    expect(depot.enregistrerOffre(offre({ empreinte_detail: null }), J2)).toBe('inchangee');
    expect(depot.obtenirOffre('2026-2445380')).toMatchObject({ empreinte_detail: 'd1', date_maj_detail: J1 });
  });

  it('expire après 3 absences, et réactive une offre qui réapparaît', () => {
    depot.enregistrerOffre(offre(), J1);
    depot.noterAbsences(['2026-2445380']);
    depot.noterAbsences(['2026-2445380']);
    expect(depot.expirer(3)).toEqual([]);
    depot.noterAbsences(['2026-2445380']);
    expect(depot.expirer(3)).toEqual(['2026-2445380']);
    expect(depot.listerOffres('expiree')).toHaveLength(1);
    depot.enregistrerOffre(offre(), J2);
    expect(depot.obtenirOffre('2026-2445380')).toMatchObject({ statut: 'active', absences_consecutives: 0 });
  });

  it('clôture une offre dont la date limite est passée, sans toucher aux autres', () => {
    depot.enregistrerOffre(offre(), J1);
    depot.enregistrerOffre(offre({ id_offre: 'B', date_limite_candidature: null }), J1);
    expect(depot.cloturer('2026-11-16')).toEqual([]);
    expect(depot.cloturer('2026-11-17')).toEqual(['2026-2445380']);
    expect(depot.obtenirOffre('B')!.statut).toBe('active');
  });

  it('retrouve une republication par empreinte identité', () => {
    depot.enregistrerOffre(offre(), J1);
    depot.enregistrerOffre(offre({ id_offre: '2026-9999999' }), J2);
    expect(depot.trouverRepublication('i1', '2026-9999999')).toBe('2026-2445380');
    depot.marquerRepublication('2026-9999999', '2026-2445380');
    expect(depot.obtenirOffre('2026-9999999')!.republication_de).toBe('2026-2445380');
    expect(depot.trouverRepublication('autre', '2026-9999999')).toBeUndefined();
  });

  it('lie une offre à plusieurs recherches sans doublon', () => {
    depot.enregistrerOffre(offre(), J1);
    depot.lierRecherche('numerique-orleans', '2026-2445380');
    depot.lierRecherche('rh-paca', '2026-2445380');
    depot.lierRecherche('rh-paca', '2026-2445380');
    expect(depot.recherchesDe('2026-2445380')).toEqual(['numerique-orleans', 'rh-paca']);
  });

  it('refuse une valeur hors domaine (contrainte CHECK)', () => {
    // Drizzle enveloppe l'erreur SQLite : le motif est dans `cause`.
    const cause = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return String((e as Error).cause);
      }
      return 'aucune erreur';
    };
    expect(cause(() => depot.enregistrerOffre(offre({ categorie: 'D' as 'A' }), J1))).toMatch(
      /CHECK.*offres_categorie/,
    );
    depot.enregistrerOffre(offre(), J1);
    expect(
      cause(() => depot.poserGeo('2026-2445380', { latitude: 120, longitude: 7, precision_geo: 'commune' })),
    ).toMatch(/CHECK.*offres_latitude/);
  });

  it('annule toute la transaction englobante en cas d’erreur', () => {
    expect(() =>
      depot.transaction(() => {
        depot.enregistrerOffre(offre(), J1);
        throw new Error('panne au milieu');
      }),
    ).toThrow('panne');
    expect(depot.listerOffres()).toEqual([]);
  });
});

describe('résumés', () => {
  it('enregistre le résumé, complète le type de contrat seulement s’il manque, vide la file', () => {
    depot.enregistrerOffre(offre({ type_contrat: null }), J1);
    depot.ajouterAResumer('2026-2445380', 'nouvelle', '/brut/x.txt', J1);
    depot.ajouterAResumer('2026-2445380', 'modifiee', '/brut/y.txt', J2);
    expect(depot.aResumer()).toEqual([
      { id_offre: '2026-2445380', raison: 'nouvelle', chemin_brut: '/brut/y.txt', date: J2 },
    ]);
    depot.enregistrerResume('2026-2445380', resume, J2);
    const o = depot.obtenirOffre('2026-2445380')!;
    expect(o).toMatchObject({
      type_contrat: 'contractuel',
      temps_travail: 'complet',
      management: false,
      competences: ['GRH', 'sourcing'],
      points_attention: ['Forte saisonnalité de juin à octobre'],
      date_resume: J2,
    });
    expect(depot.aResumer()).toEqual([]);
  });

  it('ne laisse pas le résumé écraser un type de contrat lu sur la page', () => {
    depot.enregistrerOffre(offre(), J1);
    depot.enregistrerResume('2026-2445380', resume, J2);
    expect(depot.obtenirOffre('2026-2445380')!.type_contrat).toBe('titulaire_ou_contractuel');
  });

  it("garde le type de contrat issu du résumé quand le code n'en trouve toujours pas", () => {
    depot.enregistrerOffre(offre({ type_contrat: null }), J1);
    depot.enregistrerResume('2026-2445380', resume, J1);
    depot.enregistrerOffre(offre({ type_contrat: null }), J2);
    expect(depot.obtenirOffre('2026-2445380')!.type_contrat).toBe('contractuel');
  });

  it('refuse le résumé d’une offre inconnue sans toucher à la file', () => {
    expect(() => depot.enregistrerResume('inconnue', resume, J1)).toThrow('Offre inconnue');
  });
});

describe('caches et exécutions', () => {
  it('lit et remplace une entrée de géocodage', () => {
    const g = {
      cle_lieu: '45000 orleans',
      latitude: 47.9,
      longitude: 1.9,
      precision_geo: 'commune' as const,
      source: 'ign',
      date: J1,
    };
    depot.ecrireGeocodage(g);
    depot.ecrireGeocodage({ ...g, latitude: 47.91 });
    expect(depot.lireGeocodage('45000 orleans')).toMatchObject({ latitude: 47.91 });
    expect(depot.lireGeocodage('absent')).toBeUndefined();
  });

  it('met en cache un lieu introuvable, jamais des coordonnées incomplètes', () => {
    const vide = { cle_lieu: 'loiret', latitude: null, longitude: null, precision_geo: null, source: 'ign', date: J1 };
    depot.ecrireGeocodage(vide);
    expect(depot.lireGeocodage('loiret')).toMatchObject({ latitude: null, precision_geo: null });
    expect(() => depot.ecrireGeocodage({ ...vide, latitude: 47.9 })).toThrow();
  });

  it('pose les coordonnées sans que la collecte suivante les efface', () => {
    depot.enregistrerOffre(offre(), J1);
    expect(depot.offresSansGeo().map((o) => o.id_offre)).toEqual(['2026-2445380']);
    depot.poserGeo('2026-2445380', { latitude: 43.7, longitude: 7.26, precision_geo: 'commune' });
    depot.enregistrerOffre(offre({ empreinte_detail: 'd2' }), J2);
    expect(depot.obtenirOffre('2026-2445380')).toMatchObject({ latitude: 43.7, precision_geo: 'commune' });
    expect(depot.offresSansGeo()).toEqual([]);
  });

  it('met en cache un trajet, y compris « aucun itinéraire », et oublie ceux d’une origine', () => {
    depot.ecrireTrajet({
      cle_origine: 'o',
      cle_destination: 'd',
      heure_ref: '08:00',
      duree_min: 45,
      nb_correspondances: 1,
      date: J1,
    });
    depot.ecrireTrajet({
      cle_origine: 'o',
      cle_destination: 'd2',
      heure_ref: '08:00',
      duree_min: null,
      nb_correspondances: null,
      date: J1,
    });
    expect(depot.lireTrajet('o', 'd', '08:00')).toMatchObject({ duree_min: 45, nb_correspondances: 1 });
    expect(depot.lireTrajet('o', 'd2', '08:00')).toMatchObject({ duree_min: null });
    depot.ecrireTrajet({
      cle_origine: 'autre',
      cle_destination: 'd',
      heure_ref: '08:00',
      duree_min: 30,
      nb_correspondances: 0,
      date: J1,
    });
    expect(depot.viderTrajets('o')).toBe(2);
    expect(depot.lireTrajet('autre', 'd', '08:00')).toBeDefined();
  });

  it('enregistre le début et la fin d’une exécution', () => {
    const id = depot.commencerExecution('2026-10-20T06:00:00Z');
    expect(depot.derniereExecution()).toMatchObject({ id, statut: 'en_cours', fin: null });
    depot.terminerExecution(id, {
      fin: '2026-10-20T06:05:00Z',
      statut: 'complete',
      code_sortie: 0,
      nb_cartes: 42,
      nb_nouvelles: 3,
    });
    expect(depot.derniereExecution()).toMatchObject({
      statut: 'complete',
      nb_cartes: 42,
      nb_nouvelles: 3,
      nb_modifiees: null,
    });
  });
});

describe('injection SQL', () => {
  const malveillants = [
    "'; DROP TABLE offres; --",
    "x' OR '1'='1",
    '2026-1"); DELETE FROM offres; --',
    "Robert'); UPDATE offres SET statut = 'expiree'; --",
  ];

  it.each(malveillants)('stocke %j tel quel, sans l’exécuter', (texte) => {
    depot.enregistrerOffre(offre(), J1);
    depot.enregistrerOffre(offre({ id_offre: texte, titre: texte, employeur: texte }), J1);
    depot.lierRecherche(texte, texte);
    depot.ajouterAResumer(texte, 'nouvelle', texte, J1);
    expect(depot.obtenirOffre(texte)).toMatchObject({ id_offre: texte, titre: texte, employeur: texte });
    expect(depot.obtenirOffre('2026-2445380')!.statut).toBe('active');
    expect(depot.listerOffres()).toHaveLength(2);
  });

  it('ne trouve rien avec une clé de cache piégée', () => {
    depot.ecrireGeocodage({
      cle_lieu: 'nice',
      latitude: 43.7,
      longitude: 7.26,
      precision_geo: 'commune',
      source: 'ign',
      date: J1,
    });
    expect(depot.lireGeocodage("' OR 1=1 --")).toBeUndefined();
  });
});
