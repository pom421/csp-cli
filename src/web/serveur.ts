// `csp web` : application de consultation des offres (dossier web/, compilé dans web/dist), servie en local.
// Lecture seule de la base, aucun appel réseau sortant (les trajets viennent du cache), écoute sur 127.0.0.1 seulement.
import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, sep } from 'node:path';
import type { Depot } from '../db/depot.ts';
import type { Execution, Offre } from '../db/schema.ts';
import { cleOrigine, trajetEnCache } from '../geo/trajets.ts';
import { origine } from '../securite/urls.ts';
import type { DerniereCollecte, OffreWeb, RechercheWeb, ReponseOffres, TrajetWeb } from './contrat.ts';

export const DOSSIER_APPLICATION = new URL('../../web/dist', import.meta.url).pathname;

export interface SourceDonnees {
  depot: Depot;
  /** Recherches de recherches.yaml (avec leur point de départ) ; vide si le fichier manque. */
  recherches: RechercheWeb[];
  avertissement: string | null;
  heure: string;
  aujourdhui: () => string;
}

/** Lien de l'offre seulement s'il pointe vers le site : une URL en base ne doit pas mener ailleurs. */
function lienSite(url: string): string | null {
  try {
    const u = new URL(url);
    return u.origin === origine('site') ? u.href : null;
  } catch {
    return null;
  }
}

function versWeb(o: Offre, recherches: string[], trajets: Record<string, TrajetWeb | null>): OffreWeb {
  return {
    id_offre: o.id_offre,
    url: lienSite(o.url),
    titre: o.titre,
    employeur: o.employeur,
    versant: o.versant,
    categorie: o.categorie,
    type_contrat: o.type_contrat,
    duree_contrat_mois: o.duree_contrat_mois,
    temps_travail: o.temps_travail,
    metier: o.metier,
    domaine: o.domaine,
    commune: o.commune,
    code_postal: o.code_postal,
    departement: o.departement,
    teletravail_possible: o.teletravail_possible,
    teletravail_jours_semaine: o.teletravail_jours_semaine,
    remuneration_min: o.remuneration_min,
    remuneration_max: o.remuneration_max,
    remuneration_texte: o.remuneration_texte,
    management: o.management,
    taille_equipe: o.taille_equipe,
    experience_annees_min: o.experience_annees_min,
    niveau_diplome: o.niveau_diplome,
    competences: o.competences ?? [],
    points_attention: o.points_attention ?? [],
    resume: o.resume,
    date_publication: o.date_publication,
    date_limite_candidature: o.date_limite_candidature,
    date_prise_poste: o.date_prise_poste,
    date_premiere_vue: o.date_premiere_vue,
    date_derniere_vue: o.date_derniere_vue,
    date_maj_detail: o.date_maj_detail,
    statut: o.statut,
    republication: o.republication_de !== null,
    recherches,
    trajets,
  };
}

const collecte = (e: Execution | undefined): DerniereCollecte | null =>
  e
    ? {
        debut: e.debut,
        fin: e.fin,
        statut: e.statut,
        nb_nouvelles: e.nb_nouvelles,
        nb_modifiees: e.nb_modifiees,
        nb_expirees: e.nb_expirees,
      }
    : null;

/** Toutes les offres de la base, avec leurs recherches et leurs trajets en cache. */
export function donneesOffres(source: SourceDonnees): ReponseOffres {
  const { depot, heure } = source;
  const parOffre = new Map<string, string[]>();
  for (const l of depot.liensRecherches()) {
    parOffre.set(l.id_offre, [...(parOffre.get(l.id_offre) ?? []), l.nom_recherche]);
  }
  // Recherches du fichier, puis celles qui n'y sont plus mais ont encore des offres en base (sans trajets).
  const recherches = [...source.recherches];
  const connues = new Set(recherches.map((r) => r.nom));
  for (const nom of [...new Set([...parOffre.values()].flat())].sort()) {
    if (!connues.has(nom)) recherches.push({ nom, depart: null });
  }
  const cles = new Map(recherches.filter((r) => r.depart).map((r) => [r.nom, cleOrigine(r.depart!)]));
  const offres = depot.listerOffres().map((o) => {
    const noms = parOffre.get(o.id_offre) ?? [];
    const trajets: Record<string, TrajetWeb | null> = {};
    for (const nom of noms) {
      const cle = cles.get(nom);
      const t = cle === undefined ? undefined : trajetEnCache(depot, { cle }, o, heure);
      if (t !== undefined) trajets[nom] = t;
    }
    return versWeb(o, noms, trajets);
  });
  return {
    aujourdhui: source.aujourdhui(),
    derniere_collecte: collecte(depot.derniereExecution()),
    recherches,
    avertissement: source.avertissement,
    offres,
  };
}

// ── Serveur HTTP ────────────────────────────────────────────────────────────

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
};

/**
 * Le navigateur n'exécute que les scripts de l'application ; ni cadre, ni formulaire, ni requête vers un autre
 * serveur. Les styles en ligne restent permis : certains composants (Radix) en posent.
 */
const ENTETES_SECURITE = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
    "connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function repondre(res: ServerResponse, code: number, type: string, corps: string | Buffer, cache = 'no-store') {
  res.writeHead(code, { ...ENTETES_SECURITE, 'Content-Type': type, 'Cache-Control': cache });
  res.end(corps);
}

const texte = (res: ServerResponse, code: number, message: string) =>
  repondre(res, code, 'text/plain; charset=utf-8', message);

/** Fichier de l'application ; un chemin sans extension renvoie index.html (application d'une seule page). */
async function fichierStatique(dossier: string, chemin: string): Promise<{ type: string; corps: Buffer } | null> {
  let decode: string;
  try {
    decode = decodeURIComponent(chemin);
  } catch {
    return null;
  }
  const cible = normalize(join(dossier, decode));
  // `..` ou chemin absolu encodé : rien en dehors du dossier de l'application.
  if (cible !== dossier && !cible.startsWith(dossier + sep)) return null;
  const ext = extname(cible);
  const fichier = ext ? cible : join(dossier, 'index.html');
  const type = TYPES[ext || '.html'];
  if (!type) return null;
  try {
    if (!(await stat(fichier)).isFile()) return null;
    return { type, corps: await readFile(fichier) };
  } catch {
    return null;
  }
}

export interface OptionsWeb {
  source: SourceDonnees;
  port: number;
  dossier?: string;
}

export interface ServeurWeb {
  url: string;
  fermer(): Promise<void>;
}

export function demarrerWeb({ source, port, dossier = DOSSIER_APPLICATION }: OptionsWeb): Promise<ServeurWeb> {
  const racine = normalize(dossier);
  const serveur = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Hôte attendu seulement : une page d'un autre site ne peut pas viser ce serveur par un nom de domaine
    // qui pointerait vers 127.0.0.1 (DNS rebinding).
    const { port: ecoute } = serveur.address() as AddressInfo;
    const hotes = [`127.0.0.1:${ecoute}`, `localhost:${ecoute}`];
    if (!hotes.includes(req.headers.host ?? '')) return texte(res, 403, 'Hôte refusé');
    if (req.method !== 'GET' && req.method !== 'HEAD') return texte(res, 405, 'Méthode refusée');
    const chemin = new URL(req.url ?? '/', 'http://local').pathname;
    if (chemin === '/api/offres') {
      try {
        return repondre(res, 200, 'application/json; charset=utf-8', JSON.stringify(donneesOffres(source)));
      } catch (e) {
        console.error(e);
        return texte(res, 500, 'Erreur de lecture de la base');
      }
    }
    if (chemin.startsWith('/api/')) return texte(res, 404, 'Introuvable');
    fichierStatique(racine, chemin).then(
      (f) => {
        if (!f) return texte(res, 404, 'Introuvable');
        // Fichiers compilés à nom haché : mis en cache ; index.html toujours relu.
        const cache = chemin.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
        repondre(res, 200, f.type, f.corps, cache);
      },
      () => texte(res, 500, 'Erreur'),
    );
  });
  return new Promise((ok, ko) => {
    serveur.once('error', ko);
    serveur.listen(port, '127.0.0.1', () => {
      const { port: ecoute } = serveur.address() as AddressInfo;
      ok({
        url: `http://127.0.0.1:${ecoute}/`,
        // Les connexions gardées ouvertes par le navigateur sont coupées : sinon l'arrêt attendrait leur expiration.
        fermer: () =>
          new Promise((fin) => {
            serveur.close(() => fin());
            serveur.closeAllConnections();
          }),
      });
    });
  });
}
