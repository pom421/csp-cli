// Tests de bout en bout : le binaire est lancé dans un sous-processus, contre le faux site.
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { demarrer, robotsParDefaut } from './faux-site.ts';
import { fixture, pageMinimale } from './outils.ts';

const CLI = new URL('../cli.ts', import.meta.url).pathname;

/** Recherche catégorie B (une offre, servie depuis la fixture), avec un point de départ connu du faux géocodeur. */
const RECHERCHE_B = 'recherches:\n  - nom: b\n    categories: [B]\n    depart: adresse de départ fictive\n';

const RESUME = {
  resume: '- Missions\n- Profil\n- Conditions',
  points_attention: [],
  competences: ['GRH'],
  type_contrat: null,
  duree_contrat_mois: null,
  temps_travail: null,
  teletravail_jours_semaine: null,
  remuneration_min: null,
  remuneration_max: null,
  remuneration_texte: null,
  management: null,
  taille_equipe: null,
  experience_annees_min: null,
  niveau_diplome: null,
  date_prise_poste: null,
};

let site: Awaited<ReturnType<typeof demarrer>>;
beforeAll(async () => {
  site = await demarrer((req, res) => {
    // Recherche « essai » sans filtre : 2 pages, puis fin.
    if (req.url === '/nos-offres/') res.writeHead(200, { 'content-type': 'text/html' }).end(pageMinimale('A-1', true));
    else if (req.url === '/nos-offres/page/2/') res.writeHead(200).end(pageMinimale('B-2', false));
    else if (req.url === '/nos-offres/filtres/categorie/1807/')
      res.writeHead(200).end('<html><body>refonte</body></html>');
    // Recherche catégorie B : une offre dont la page détail est servie depuis la fixture.
    else if (req.url === '/nos-offres/filtres/categorie/1806/')
      res.writeHead(200).end(pageMinimale('2026-2445380', false));
    else if (req.url === '/offre-emploi/poste-reference-2026-2445380/')
      res.writeHead(200).end(fixture('detail-2026-2445380'));
    // Fausse Géoplateforme : la commune de l'offre de la fixture, et l'adresse de départ fictive.
    else if (req.url?.startsWith('/geocodage/search?')) {
      const parametres = new URL(req.url, site.url).searchParams;
      const q = parametres.get('index') === 'poi' ? '' : (parametres.get('q') ?? '');
      const trouve = q === 'Nice' || q === 'adresse de départ fictive';
      const feature = {
        geometry: { coordinates: q === 'Nice' ? [7.27, 43.7] : [7.2, 43.66] },
        // Les cartes de test annoncent toutes le Loiret.
        properties: { type: q === 'Nice' ? 'municipality' : 'housenumber', score: 0.9, depcode: '45' },
      };
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ features: trouve ? [feature] : [] }));
    }
    // Faux Transitous : arrivée 42 minutes après l'heure demandée.
    else if (req.url?.startsWith('/api/v5/plan?')) {
      const depart = Date.parse(new URL(req.url, site.url).searchParams.get('time') ?? '');
      const fin = new Date(depart + 42 * 60_000).toISOString();
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          itineraries: [{ startTime: new Date(depart).toISOString(), endTime: fin, transfers: 1 }],
          direct: [],
        }),
      );
    }
    // Faux Albert : renvoie toujours le même résumé valide.
    else if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      req.resume();
      req.on('end', () =>
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(RESUME) }, finish_reason: 'stop' }] })),
      );
    } else robotsParDefaut(req, res);
  });
});
afterAll(() => site.fermer());

async function csp(home: string, ...argv: string[]) {
  const env = {
    PATH: process.env.PATH,
    CSP_HOME: home,
    CSP_SITE_URL: site.url,
    CSP_GEOCODAGE_URL: site.url,
    CSP_TRAJETS_URL: site.url,
    CSP_DELAI_MS: '0',
    CSP_ALBERT_URL: site.url,
  };
  try {
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', CLI, ...argv],
      { env },
    );
    return { code: 0, sortie: stdout + stderr };
  } catch (e) {
    const err = e as { code: number; stdout: string; stderr: string };
    return { code: err.code, sortie: err.stdout + err.stderr };
  }
}

function homeComplet() {
  const home = join(mkdtempSync(join(tmpdir(), 'csp-')), 'csp-cli');
  mkdirSync(home, { mode: 0o700 });
  writeFileSync(join(home, '.env'), 'CSP_HEURE_DEPART=08:00\n', { mode: 0o600 });
  writeFileSync(join(home, 'recherches.yaml'), 'recherches:\n  - nom: essai\n', { mode: 0o600 });
  return home;
}

describe('csp', () => {
  it("affiche l'aide sans commande et échoue sur une commande inconnue", async () => {
    expect(await csp(homeComplet())).toMatchObject({ code: 0, sortie: expect.stringContaining('doctor') });
    expect((await csp(homeComplet(), 'inconnue')).code).toBe(1);
  });

  it('refuse un argument en trop', async () => {
    expect(await csp(homeComplet(), 'doctor', 'x')).toMatchObject({
      code: 1,
      sortie: expect.stringContaining('inattendu'),
    });
  });
});

describe('csp doctor', () => {
  it('tout est prêt avec une configuration complète', async () => {
    const r = await csp(homeComplet(), 'doctor');
    expect(r.sortie).toContain('robots.txt inchangé');
    expect(r.sortie).toContain('1 : essai');
    expect(r).toMatchObject({ code: 0, sortie: expect.stringContaining('Tout est prêt') });
  });

  it('signale un dossier absent', async () => {
    const r = await csp(join(tmpdir(), 'csp-absent-' + Date.now()), 'doctor');
    expect(r).toMatchObject({ code: 1, sortie: expect.stringContaining('mkdir -m 700') });
  });

  it('signale des droits trop ouverts sur le dossier et le .env', async () => {
    const home = homeComplet();
    chmodSync(join(home, '.env'), 0o644);
    expect(await csp(home, 'doctor')).toMatchObject({ code: 1, sortie: expect.stringContaining('chmod 600') });
    chmodSync(home, 0o755);
    expect(await csp(home, 'doctor')).toMatchObject({ code: 1, sortie: expect.stringContaining('chmod 700') });
  });

  it('signale une configuration de recherches invalide', async () => {
    const home = homeComplet();
    writeFileSync(join(home, 'recherches.yaml'), 'recherches:\n  - nom: a\n    versants: [FPX]\n');
    expect(await csp(home, 'doctor')).toMatchObject({ code: 1, sortie: expect.stringContaining('versants') });
  });
});

describe('csp collecte', () => {
  it('--dry-run parcourt les pages et liste les nouvelles offres sans créer la base', async () => {
    const home = homeComplet();
    const r = await csp(home, 'collecte', '--dry-run');
    expect(r).toMatchObject({ code: 0, sortie: expect.stringContaining('essai : 9999 annoncée(s), 2 page(s) lue(s)') });
    expect(r.sortie).toContain('nouvelles : 2');
    expect(r.sortie).toContain(`${site.url}/offre-emploi/poste-reference-B-2/`);
    expect(existsSync(join(home, 'csp.sqlite'))).toBe(false);
  });

  it('--json renvoie le bilan structuré', async () => {
    const r = await csp(homeComplet(), 'collecte', '--dry-run', '--json');
    expect(JSON.parse(r.sortie)).toMatchObject({ nouvelles: ['A-1', 'B-2'], absentes: [] });
  });

  it('sort en code 2 avec l’étape quand la page a changé de structure', async () => {
    const home = homeComplet();
    writeFileSync(join(home, 'recherches.yaml'), 'recherches:\n  - nom: c\n    categories: [C]\n');
    const r = await csp(home, 'collecte', '--dry-run');
    expect(r).toMatchObject({ code: 2, sortie: expect.stringContaining('[lire-compteur]') });
    const dossier = /Diagnostic : (.+)/.exec(r.sortie)?.[1];
    expect(dossier?.startsWith(join(home, 'diagnostics'))).toBe(true);
    expect(existsSync(join(dossier!, 'page.html'))).toBe(true);
    expect(await csp(home, 'purge', '--dry-run')).toMatchObject({
      code: 1,
      sortie: expect.stringContaining('Base absente'),
    });
  });

  it('sans --dry-run : lit le détail, crée la base en 0600 et le texte brut à résumer', async () => {
    const home = homeComplet();
    writeFileSync(join(home, 'recherches.yaml'), RECHERCHE_B);
    const r = await csp(home, 'collecte');
    expect(r).toMatchObject({ code: 0, sortie: expect.stringContaining('nouvelles : 1') });
    expect(r.sortie).toContain('À résumer : 1');
    expect(statSync(join(home, 'csp.sqlite')).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, 'brut', '2026-2445380.txt')).mode & 0o777).toBe(0o600);
    expect(r.sortie).toContain('Géocodage : 4 appel(s), 0 offre(s) sans coordonnées');
    expect(r.sortie).toContain('Trajets (transitous) :');
    expect(r.sortie).toMatch(/b, depuis adresse de départ fictive : 1 calculé\(s\)/);
    const encore = await csp(home, 'collecte');
    expect(encore.sortie).toContain('inchangées : 1');
    expect(encore.sortie).toContain('Géocodage : 0 appel(s)');
    expect(encore.sortie).toContain('0 calculé(s), 1 en cache');
  });
});

describe('csp trajets', () => {
  it('liste les trajets en cache, et les recalcule tous avec --recalculer', async () => {
    const home = homeComplet();
    writeFileSync(join(home, 'recherches.yaml'), RECHERCHE_B);
    expect(await csp(home, 'trajets')).toMatchObject({ code: 1, sortie: expect.stringContaining('Base absente') });
    await csp(home, 'collecte');
    const r = await csp(home, 'trajets');
    expect(r).toMatchObject({ code: 0, sortie: expect.stringContaining('0 calculé(s), 1 en cache') });
    expect(r.sortie).toContain('40 min, 1 correspondance(s) — Chargé(e) de mission');
    expect((await csp(home, 'trajets', '--recalculer')).sortie).toContain('1 calculé(s), 0 en cache');
  });

  it('exige au moins une recherche avec un point de départ', async () => {
    const home = homeComplet();
    writeFileSync(join(home, 'recherches.yaml'), RECHERCHE_B);
    await csp(home, 'collecte');
    writeFileSync(join(home, 'recherches.yaml'), 'recherches:\n  - nom: b\n    categories: [B]\n');
    expect(await csp(home, 'trajets')).toMatchObject({
      code: 1,
      sortie: expect.stringContaining('Aucune recherche n’a de point de départ'),
    });
  });
});

describe('csp a-resumer, resume enregistrer, resumer', () => {
  async function homeAvecFile() {
    const home = homeComplet();
    writeFileSync(join(home, 'recherches.yaml'), RECHERCHE_B);
    await csp(home, 'collecte');
    return home;
  }

  it('liste la file, enregistre un résumé écrit à la main et purge le texte brut', async () => {
    const home = await homeAvecFile();
    const file = JSON.parse((await csp(home, 'a-resumer', '--json')).sortie) as {
      id_offre: string;
      chemin_brut: string;
    }[];
    expect(file.map((a) => a.id_offre)).toEqual(['2026-2445380']);
    const json = join(home, 'resume.json');
    writeFileSync(json, JSON.stringify(RESUME));
    expect(await csp(home, 'resume', 'enregistrer', '2026-2445380', json)).toMatchObject({ code: 0 });
    expect(existsSync(file[0].chemin_brut)).toBe(false);
    expect((await csp(home, 'a-resumer')).sortie).toContain('Aucune offre à résumer');
  });

  it('refuse un résumé invalide sans toucher à la file', async () => {
    const home = await homeAvecFile();
    const json = join(home, 'resume.json');
    writeFileSync(json, JSON.stringify({ ...RESUME, resume: 'Contact : a.b@exemple.fr' }));
    expect(await csp(home, 'resume', 'enregistrer', '2026-2445380', json)).toMatchObject({
      code: 1,
      sortie: expect.stringContaining('contient une coordonnée'),
    });
    expect((await csp(home, 'a-resumer')).sortie).toContain('2026-2445380');
  });

  it('resumer passe par le fournisseur du .env (Albert)', async () => {
    const home = await homeAvecFile();
    writeFileSync(
      join(home, '.env'),
      'CSP_LLM_FOURNISSEUR=albert\nCSP_LLM_CLE=cle-de-test-albert\nCSP_LLM_MODELE=albert-large\n',
      { mode: 0o600 },
    );
    const r = await csp(home, 'resumer');
    expect(r).toMatchObject({ code: 0, sortie: expect.stringContaining('Fournisseur : albert (albert-large)') });
    expect(r.sortie).toContain('Résumées : 1, échecs : 0, restantes : 0');
  });

  it('sans base : message explicite', async () => {
    expect(await csp(homeComplet(), 'a-resumer')).toMatchObject({
      code: 1,
      sortie: expect.stringContaining('csp collecte'),
    });
  });
});
