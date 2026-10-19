// Liste blanche des origines contactées par le code (PLAN §8 « Réseau »).
// Toute autre URL est refusée, y compris les liens trouvés dans le texte des offres.
import { UserError } from '../erreurs.ts';

export type Service = 'site' | 'geocodage' | 'trajets' | 'anthropic' | 'albert';

const ORIGINES_OFFICIELLES: Record<Service, string> = {
  site: 'https://choisirleservicepublic.gouv.fr',
  geocodage: 'https://data.geopf.fr',
  trajets: 'https://api.transitous.org',
  // Fournisseurs de résumés (un seul utilisé à la fois, choisi par CSP_LLM_FOURNISSEUR).
  anthropic: 'https://api.anthropic.com',
  albert: 'https://albert.api.etalab.gouv.fr',
};

const VARIABLES: Record<Service, string> = {
  site: 'CSP_SITE_URL',
  geocodage: 'CSP_GEOCODAGE_URL',
  trajets: 'CSP_TRAJETS_URL',
  anthropic: 'CSP_ANTHROPIC_URL',
  albert: 'CSP_ALBERT_URL',
};

const HOTES_LOCAUX = ['localhost', '127.0.0.1', '[::1]'];

/**
 * Chemins du site jamais téléchargés : PDF des offres (interdits par robots.txt) et administration.
 * Comparés au chemin décodé et en minuscules, pour qu'un encodage (%2F, majuscules) ne les contourne pas.
 */
const CHEMINS_INTERDITS = ['/wp-content/uploads/pdf-offers/', '/wp-admin/'];

/**
 * Origine d'un service. Une variable d'environnement ne peut la remplacer que par un serveur local
 * (tests contre le faux site) : impossible d'élargir la liste blanche à un autre domaine.
 */
export function origine(service: Service): string {
  const nom = VARIABLES[service];
  const brut = process.env[nom];
  if (!brut) return ORIGINES_OFFICIELLES[service];
  let url: URL;
  try {
    url = new URL(brut);
  } catch {
    throw new UserError(`${nom} invalide : ${brut}`);
  }
  if (url.origin === ORIGINES_OFFICIELLES[service]) return url.origin;
  if (!HOTES_LOCAUX.includes(url.hostname) || !['http:', 'https:'].includes(url.protocol)) {
    throw new UserError(`${nom} ne peut désigner qu'un serveur local (tests) : ${brut}`);
  }
  return url.origin;
}

export const originesAutorisees = (): string[] => (Object.keys(VARIABLES) as Service[]).map(origine);

/** Vérifie une URL avant tout appel réseau ; renvoie l'URL normalisée. */
export function urlAutorisee(brut: string | URL): URL {
  let url: URL;
  try {
    url = new URL(brut);
  } catch {
    throw new UserError(`URL invalide : ${String(brut)}`);
  }
  if (url.username || url.password) throw new UserError(`URL avec identifiants refusée : ${url.origin}`);
  const local = HOTES_LOCAUX.includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new UserError(`HTTPS obligatoire : ${url.href}`);
  }
  if (!originesAutorisees().includes(url.origin)) {
    throw new UserError(`Origine hors liste blanche : ${url.origin}`);
  }
  if (url.origin === origine('site')) {
    let chemin: string;
    try {
      chemin = decodeURIComponent(url.pathname).toLowerCase();
    } catch {
      throw new UserError(`Chemin mal encodé : ${url.pathname}`);
    }
    const interdit = CHEMINS_INTERDITS.find((p) => chemin.startsWith(p));
    if (interdit) throw new UserError(`Chemin interdit par robots.txt ou le projet : ${interdit}`);
  }
  return url;
}
