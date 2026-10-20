// Accès réseau unique du projet : liste blanche, HTTPS, débit limité, user-agent identifiant,
// classement des échecs en codes de sortie (indisponible / blocage).
import http from 'node:http';
import tls from 'node:tls';
import { BlocageError, IndisponibleError } from './erreurs.ts';
import { urlAutorisee } from './securite/urls.ts';

/** Nom, version et contact : exigés par Transitous, utiles à tout service qui voudrait nous joindre. */
export const USER_AGENT = 'csp-cli/0.1 (+https://github.com/pom421/csp-cli; veille personnelle)';

/** Délai minimal entre deux requêtes vers une même origine (politesse, CONFORMITE.md règle 3). */
const delaiMs = () => Number(process.env.CSP_DELAI_MS ?? 2500);
const TIMEOUT_MS = 30_000;
const MAX_REDIRECTIONS = 3;

const derniereRequete = new Map<string, number>();

async function attendreTour(origine: string): Promise<void> {
  const attente = (derniereRequete.get(origine) ?? 0) + delaiMs() - Date.now();
  if (attente > 0) await new Promise((r) => setTimeout(r, attente));
  derniereRequete.set(origine, Date.now());
}

export interface Reponse {
  url: string;
  statut: number;
  texte: string;
}

/**
 * GET poli. Les redirections sont suivies à la main pour revérifier la liste blanche à chaque saut.
 * Aucun cookie n'est envoyé ni conservé.
 */
export async function obtenir(
  brut: string | URL,
  accept = 'text/html',
  entetes: Record<string, string> = {},
): Promise<Reponse> {
  let url = urlAutorisee(brut);
  for (let saut = 0; saut <= MAX_REDIRECTIONS; saut++) {
    await attendreTour(url.origin);
    let res: Response;
    try {
      res = await fetch(url, {
        redirect: 'manual',
        headers: { 'user-agent': USER_AGENT, accept, ...entetes },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw new IndisponibleError(`${url.origin} injoignable : ${(e as Error).message}`);
    }
    if (res.status >= 300 && res.status < 400) {
      const cible = res.headers.get('location');
      await res.body?.cancel();
      if (!cible) throw new IndisponibleError(`Redirection sans destination : ${url.href}`);
      url = urlAutorisee(new URL(cible, url));
      continue;
    }
    if (res.status === 403 || res.status === 429) {
      await res.body?.cancel();
      throw new BlocageError(`${url.href} : HTTP ${res.status}, arrêt sans contournement`);
    }
    if (res.status >= 500) {
      await res.body?.cancel();
      throw new IndisponibleError(`${url.href} : HTTP ${res.status}`);
    }
    return { url: url.href, statut: res.status, texte: await res.text() };
  }
  throw new IndisponibleError(`Trop de redirections : ${url.href}`);
}

/**
 * `fetch` restreint à la liste blanche, sans redirection : passé aux bibliothèques qui font leurs propres appels
 * (AI SDK), pour qu'aucune requête ne sorte vers une origine non prévue.
 */
export const fetchListeBlanche: typeof fetch = (entree, init) => {
  const url = entree instanceof Request ? entree.url : entree;
  urlAutorisee(url);
  return fetch(entree, { ...init, redirect: 'error' });
};

/**
 * Certificats du système (proxy d'entreprise qui inspecte le HTTPS), comme `--use-system-ca` :
 * le lanceur d'un binaire installé globalement ignore les options du shebang.
 */
export function utiliserCertificatsSysteme(): void {
  if (process.execArgv.includes('--use-system-ca')) return;
  const certs = [...tls.getCACertificates('default'), ...tls.getCACertificates('system')];
  tls.setDefaultCACertificates([...new Set(certs)]);
}

/** Le fetch de Node ignore HTTPS_PROXY par défaut : on l'active si un proxy est défini (Node ≥ 24.14). */
export function appliquerProxy(): void {
  const env = process.env;
  if (!(env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy)) return;
  const setGlobal = (http as { setGlobalProxyFromEnv?: () => unknown }).setGlobalProxyFromEnv;
  if (typeof setGlobal === 'function') setGlobal();
  else console.error('Proxy détecté mais non appliqué : Node 24.14+ requis (ou NODE_USE_ENV_PROXY=1).');
}
