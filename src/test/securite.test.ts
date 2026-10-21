import { mkdtempSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { BlocageError, IndisponibleError, UserError } from '../erreurs.ts';
import { obtenir, USER_AGENT } from '../http.ts';
import { dossierPrive, droitsTropOuverts, ecrireFichierPrive } from '../securite/fichiers.ts';
import { origine, urlAutorisee } from '../securite/urls.ts';
import { demarrer } from './faux-site.ts';

const mode = (p: string) => statSync(p).mode & 0o777;

describe('droits des fichiers locaux', () => {
  it('crée les dossiers en 0700 et corrige un dossier existant trop ouvert', () => {
    const d = join(mkdtempSync(join(tmpdir(), 'csp-')), 'a', 'b');
    dossierPrive(d);
    expect(mode(d)).toBe(0o700);
    chmodSync(d, 0o755);
    dossierPrive(d);
    expect(mode(d)).toBe(0o700);
  });

  it('écrit les fichiers en 0600, même s’ils existaient avec des droits plus larges', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'csp-')), 'x.json');
    writeFileSync(f, 'ancien', { mode: 0o644 });
    ecrireFichierPrive(f, 'nouveau');
    expect(mode(f)).toBe(0o600);
    expect(droitsTropOuverts(f)).toBe(0);
  });
});

describe('liste blanche des URL', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it('accepte le site, la Géoplateforme et Transitous en HTTPS', () => {
    expect(urlAutorisee('https://choisirleservicepublic.gouv.fr/nos-offres/').pathname).toBe('/nos-offres/');
    expect(() => urlAutorisee('https://data.geopf.fr/geocodage/search')).not.toThrow();
    expect(() => urlAutorisee('https://api.transitous.org/api/v1/plan')).not.toThrow();
  });

  it.each([
    ['http://choisirleservicepublic.gouv.fr/', 'HTTPS obligatoire'],
    ['https://exemple.com/', 'hors liste blanche'],
    ['https://choisirleservicepublic.gouv.fr.exemple.com/', 'hors liste blanche'],
    ['https://user:mdp@choisirleservicepublic.gouv.fr/', 'identifiants'],
    ['https://place-ep-recrute.talent-soft.com/flux.aspx', 'hors liste blanche'],
    ['file:///etc/passwd', 'HTTPS obligatoire'],
    ['javascript:alert(1)', 'HTTPS obligatoire'],
    ['pas une url', 'URL invalide'],
  ])('refuse %s', (url, motif) => {
    expect(() => urlAutorisee(url)).toThrow(motif);
  });

  it.each([
    'https://choisirleservicepublic.gouv.fr/wp-content/uploads/pdf-offers/offre.pdf',
    'https://choisirleservicepublic.gouv.fr/WP-CONTENT/uploads/pdf-offers/offre.pdf',
    'https://choisirleservicepublic.gouv.fr/wp-content%2Fuploads%2Fpdf-offers/offre.pdf',
    'https://choisirleservicepublic.gouv.fr/nos-offres/../wp-content/uploads/pdf-offers/x.pdf',
    'https://choisirleservicepublic.gouv.fr/wp-admin/',
  ])('refuse le chemin interdit %s', (url) => {
    expect(() => urlAutorisee(url)).toThrow(UserError);
  });

  it('ne laisse remplacer une origine que par un serveur local', () => {
    process.env.CSP_SITE_URL = 'http://127.0.0.1:4000';
    expect(origine('site')).toBe('http://127.0.0.1:4000');
    expect(() => urlAutorisee('https://choisirleservicepublic.gouv.fr/')).toThrow('hors liste blanche');
    process.env.CSP_SITE_URL = 'https://pirate.exemple.com';
    expect(() => origine('site')).toThrow('serveur local');
  });
});

describe('accès réseau', () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.CSP_DELAI_MS = '0';
  });
  afterEach(() => {
    process.env = { ...env };
  });

  it('envoie le user-agent du projet, aucun cookie, et ignore Set-Cookie', async () => {
    const site = await demarrer((_req, res) => res.writeHead(200, { 'set-cookie': 'PHPSESSID=abc' }).end('ok'));
    process.env.CSP_SITE_URL = site.url;
    await obtenir(`${site.url}/a`);
    await obtenir(`${site.url}/b`);
    await site.fermer();
    expect(site.requetes.map((r) => r.userAgent)).toEqual([USER_AGENT, USER_AGENT]);
    expect(site.requetes.every((r) => r.cookie === undefined)).toBe(true);
  });

  it('refuse une redirection vers une origine hors liste blanche', async () => {
    const site = await demarrer((_req, res) => res.writeHead(302, { location: 'https://exemple.com/' }).end());
    process.env.CSP_SITE_URL = site.url;
    await expect(obtenir(`${site.url}/`)).rejects.toThrow('hors liste blanche');
    await site.fermer();
  });

  it('refuse une redirection vers les PDF des offres', async () => {
    const site = await demarrer((_req, res) =>
      res.writeHead(301, { location: '/wp-content/uploads/pdf-offers/x.pdf' }).end(),
    );
    process.env.CSP_SITE_URL = site.url;
    await expect(obtenir(`${site.url}/offre`)).rejects.toThrow('robots.txt');
    expect(site.requetes).toHaveLength(1);
    await site.fermer();
  });

  it.each([403, 429])('classe HTTP %i en blocage (code 4)', async (statut) => {
    const site = await demarrer((_req, res) => res.writeHead(statut).end());
    process.env.CSP_SITE_URL = site.url;
    await expect(obtenir(`${site.url}/`)).rejects.toBeInstanceOf(BlocageError);
    await site.fermer();
  });

  it('retente un 503 trois fois, puis classe en indisponibilité (code 3) ; serveur injoignable aussi', async () => {
    const site = await demarrer((_req, res) => res.writeHead(503).end());
    process.env.CSP_SITE_URL = site.url;
    await expect(obtenir(`${site.url}/`)).rejects.toThrow('HTTP 503 après 4 essais');
    expect(site.requetes).toHaveLength(4);
    await site.fermer();
    await expect(obtenir(`${site.url}/`)).rejects.toBeInstanceOf(IndisponibleError);
  });

  it('un 503 passager est absorbé par une nouvelle tentative', async () => {
    let n = 0;
    const site = await demarrer((_req, res) => res.writeHead(++n === 1 ? 503 : 200).end('ok'));
    process.env.CSP_SITE_URL = site.url;
    await expect(obtenir(`${site.url}/`)).resolves.toMatchObject({ statut: 200, texte: 'ok' });
    expect(site.requetes).toHaveLength(2);
    await site.fermer();
  });

  it('espace les requêtes vers une même origine', async () => {
    process.env.CSP_DELAI_MS = '200';
    const site = await demarrer((_req, res) => res.writeHead(200).end());
    process.env.CSP_SITE_URL = site.url;
    const debut = Date.now();
    await obtenir(`${site.url}/1`);
    await obtenir(`${site.url}/2`);
    await site.fermer();
    expect(Date.now() - debut).toBeGreaterThanOrEqual(190);
  });
});
