// Chargé avant chaque fichier de test, pour qu'un test qui oublie un réglage échoue au lieu de toucher au réel :
// - aucune requête ne sort de la machine (ni le site, ni IGN, ni Transitous, ni les API LLM) ;
// - les données locales vont dans un dossier temporaire, jamais dans ~/.config/csp-cli.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CSP_HOME = mkdtempSync(join(tmpdir(), 'csp-test-'));
// Nouvelles tentatives après un 503 : quelques millisecondes au lieu de 10 s, 25 s, 60 s.
process.env.CSP_ATTENTES_503_MS = '1,1,1';

const HOTES_LOCAUX = new Set(['localhost', '127.0.0.1', '[::1]']);
const fetchReel = globalThis.fetch;

globalThis.fetch = (entree, init) => {
  const url = new URL(entree instanceof Request ? entree.url : entree);
  if (!HOTES_LOCAUX.has(url.hostname)) {
    return Promise.reject(new Error(`Test : requête réseau vers ${url.origin} interdite (injecter un faux service)`));
  }
  return fetchReel(entree, init);
};
