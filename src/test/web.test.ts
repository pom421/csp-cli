import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { Depot } from '../db/depot.ts';
import type { ChampsCode } from '../db/schema.ts';
import { cleDestination, cleOrigine, heureRef } from '../geo/trajets.ts';
import type { ReponseOffres } from '../web/contrat.ts';
import { demarrerWeb, donneesOffres, type ServeurWeb, type SourceDonnees } from '../web/serveur.ts';

const JOUR = '2026-10-20';
const ORLEANS = { latitude: 47.9029, longitude: 1.9093 };
const DEPART = 'Gare d’Austerlitz';

function offre(id: string, champs: Partial<ChampsCode> = {}): ChampsCode {
  return {
    id_offre: id,
    url: `https://choisirleservicepublic.gouv.fr/offre-emploi/x-reference-${id}/`,
    titre: `Poste ${id}`,
    employeur: 'Préfecture du Loiret',
    versant: 'FPE',
    categorie: 'A',
    type_contrat: 'titulaire',
    temps_travail: 'complet',
    metier: null,
    domaine: null,
    adresse: null,
    commune: 'Orléans',
    code_postal: '45000',
    departement: '45',
    management: null,
    teletravail_possible: true,
    date_publication: JOUR,
    date_limite_candidature: '2026-11-16',
    date_prise_poste: null,
    empreinte_carte: `c-${id}`,
    empreinte_detail: `d-${id}`,
    empreinte_identite: `i-${id}`,
    ...champs,
  };
}

/** Base en mémoire : une offre localisée avec trajet en cache, une sans coordonnées, une au lien étranger. */
function source(): SourceDonnees {
  const depot = new Depot(':memory:');
  depot.enregistrerOffre(offre('2026-1'), JOUR);
  depot.enregistrerOffre(offre('2026-2', { commune: null }), JOUR);
  depot.enregistrerOffre(offre('2026-3', { url: 'https://exemple.test/piege' }), JOUR);
  for (const id of ['2026-1', '2026-2', '2026-3']) depot.lierRecherche('loiret', id);
  depot.lierRecherche('ancienne', '2026-3');
  depot.poserGeo('2026-1', { ...ORLEANS, precision_geo: 'commune' });
  depot.ecrireTrajet({
    cle_origine: cleOrigine(DEPART),
    cle_destination: cleDestination(ORLEANS),
    heure_ref: heureRef('08:00'),
    duree_min: 65,
    nb_correspondances: 1,
    date: JOUR,
  });
  depot.enregistrerResume(
    '2026-1',
    {
      resume: '- Missions **clés**',
      points_attention: ['Astreintes'],
      competences: ['SQL'],
      duree_contrat_mois: null,
      teletravail_jours_semaine: 2,
      remuneration_min: 38_000,
      remuneration_max: 45_000,
      remuneration_texte: null,
      taille_equipe: null,
      experience_annees_min: null,
      niveau_diplome: null,
    },
    JOUR,
  );
  return {
    depot,
    recherches: [{ nom: 'loiret', depart: DEPART }],
    avertissement: null,
    heure: '08:00',
    aujourdhui: () => JOUR,
  };
}

describe('csp web : données', () => {
  it('rend les offres avec recherches, trajets en cache et résumé, sans champ interne', () => {
    const r = donneesOffres(source());
    expect(r.aujourdhui).toBe(JOUR);
    expect(r.offres.map((o) => o.id_offre)).toEqual(['2026-1', '2026-2', '2026-3']);
    const [o1, o2] = r.offres;
    expect(o1.trajets).toEqual({ loiret: { duree_min: 65, nb_correspondances: 1 } });
    expect(o1.remuneration_max).toBe(45_000);
    expect(o1.competences).toEqual(['SQL']);
    // Sans coordonnées : trajet non calculé, donc absent.
    expect(o2.trajets).toEqual({});
    expect(o2.competences).toEqual([]);
    for (const interne of ['empreinte_detail', 'absences_consecutives', 'adresse'])
      expect(o1).not.toHaveProperty(interne);
  });

  it('écarte un lien hors du site et garde les recherches absentes du fichier, sans départ', () => {
    const r = donneesOffres(source());
    expect(r.offres[0].url).toMatch(/^https:\/\/choisirleservicepublic\.gouv\.fr\//);
    expect(r.offres[2].url).toBeNull();
    expect(r.offres[2].recherches).toEqual(['ancienne', 'loiret']);
    expect(r.recherches).toEqual([
      { nom: 'loiret', depart: DEPART },
      { nom: 'ancienne', depart: null },
    ]);
  });
});

describe('csp web : serveur', () => {
  let serveur: ServeurWeb;
  let port: number;

  beforeAll(async () => {
    const dossier = mkdtempSync(join(tmpdir(), 'csp-web-'));
    mkdirSync(join(dossier, 'assets'));
    writeFileSync(join(dossier, 'index.html'), '<!doctype html><title>csp</title>');
    writeFileSync(join(dossier, 'assets', 'app.js'), 'console.log(1)');
    serveur = await demarrerWeb({ source: source(), port: 0, dossier });
    port = Number(new URL(serveur.url).port);
  });
  afterAll(() => serveur.fermer());

  /** Requête brute : `fetch` ne laisse pas choisir l'en-tête Host. */
  function brute(chemin: string, { methode = 'GET', hote = `127.0.0.1:${port}` } = {}) {
    return new Promise<{ code: number; entetes: Record<string, unknown>; corps: string }>((ok, ko) => {
      const req = request(
        { host: '127.0.0.1', port, path: chemin, method: methode, headers: { host: hote } },
        (res) => {
          let corps = '';
          res.on('data', (c: Buffer) => (corps += c.toString()));
          res.on('end', () => ok({ code: res.statusCode!, entetes: res.headers, corps }));
        },
      );
      req.on('error', ko);
      req.end();
    });
  }

  it('n’écoute que sur 127.0.0.1 et sert l’API en JSON non mis en cache', async () => {
    expect(serveur.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const r = await fetch(new URL('/api/offres', serveur.url));
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const donnees = (await r.json()) as ReponseOffres;
    expect(donnees.offres).toHaveLength(3);
  });

  it('pose les en-têtes de sécurité (CSP sans script en ligne, pas de cadre)', async () => {
    const r = await fetch(serveur.url);
    const csp = r.headers.get('content-security-policy')!;
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('sert l’application : fichiers compilés, et index.html pour toute route sans extension', async () => {
    expect(await (await fetch(new URL('/assets/app.js', serveur.url))).text()).toBe('console.log(1)');
    const page = await fetch(new URL('/une/route', serveur.url));
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('<title>csp</title>');
  });

  it('refuse un autre hôte (DNS rebinding), une écriture, une sortie du dossier', async () => {
    expect((await brute('/api/offres', { hote: 'attaquant.test' })).code).toBe(403);
    expect((await brute('/api/offres', { methode: 'POST' })).code).toBe(405);
    // `..` en clair est résolu par l'analyse de l'URL (→ /etc/passwd → index.html) ; encodé, c'est la garde qui joue.
    expect((await brute('/../../etc/passwd')).corps).toContain('<title>csp</title>');
    expect((await brute('/..%2f..%2f..%2fetc%2fpasswd')).code).toBe(404);
    expect((await brute('/assets/..%2f..%2f..%2fetc%2fhosts.js')).code).toBe(404);
    expect((await brute('/assets/absent.js')).code).toBe(404);
    expect((await brute('/api/autre')).code).toBe(404);
  });

  it('accepte localhost comme hôte', async () => {
    expect((await brute('/api/offres', { hote: `localhost:${port}` })).code).toBe(200);
  });
});
