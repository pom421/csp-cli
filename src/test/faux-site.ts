// Faux serveur local : remplace le site, la Géoplateforme et Transitous dans les tests (jamais le vrai site en CI).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type Gestionnaire = (req: IncomingMessage, res: ServerResponse) => void;

export const ROBOTS = `User-agent: *
Disallow: /wp-admin/
Disallow: /wp-content/uploads/pdf-offers/
Allow: /wp-admin/admin-ajax.php
Sitemap: https://choisirleservicepublic.gouv.fr/sitemapindex.xml`;

export const robotsParDefaut: Gestionnaire = (req, res) => {
  if (req.url === '/robots.txt') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end(ROBOTS);
  } else {
    res.writeHead(404).end();
  }
};

/** Démarre un serveur sur un port libre ; `requetes` garde la trace des chemins demandés. */
export async function demarrer(gestionnaire: Gestionnaire = robotsParDefaut) {
  const requetes: { url: string; userAgent?: string; cookie?: string }[] = [];
  const serveur = createServer((req, res) => {
    requetes.push({ url: req.url ?? '', userAgent: req.headers['user-agent'], cookie: req.headers.cookie });
    gestionnaire(req, res);
  });
  await new Promise<void>((r) => serveur.listen(0, '127.0.0.1', r));
  const { port } = serveur.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requetes,
    fermer: () => new Promise<void>((r) => serveur.close(() => r())),
  };
}
