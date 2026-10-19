// Tests de bout en bout : le binaire est lancé dans un sous-processus, contre le faux site.
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { demarrer } from './faux-site.ts';

const CLI = new URL('../cli.ts', import.meta.url).pathname;

let site: Awaited<ReturnType<typeof demarrer>>;
beforeAll(async () => {
  site = await demarrer();
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
  const home = join(mkdtempSync(join(tmpdir(), 'csp-')), 'csp-veille');
  mkdirSync(home, { mode: 0o700 });
  writeFileSync(join(home, '.env'), 'CSP_ORIGINE_TRAJET="adresse de départ fictive"\n', { mode: 0o600 });
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
