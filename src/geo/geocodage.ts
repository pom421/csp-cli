// Géocodage par la Géoplateforme IGN (service de l'ex-API Adresse, gratuit, sans clé), avec cache en base.
// Un échec réseau ou un refus du service n'arrête pas la collecte : le géocodeur se met en panne pour la journée,
// les offres restent sans coordonnées et seront localisées au prochain passage (`csp trajets`).
import { z } from 'zod';
import type { Depot } from '../db/depot.ts';
import type { Geo } from '../db/schema.ts';
import { BlocageError, IndisponibleError } from '../erreurs.ts';
import { obtenir } from '../http.ts';
import { cleComparaison } from '../scraper/normalisation.ts';
import { origine } from '../securite/urls.ts';
import { cleLieu, precisionDe, requetesLieu, type Lieu, type Mode, type Point, type Requete } from './lieux.ts';

export interface Candidat extends Point {
  /** housenumber, street, municipality… ; `mairie` pour un point d'intérêt de catégorie mairie. */
  type: string;
  score: number;
  departement: string | null;
  commune: string | null;
  /** Libellé du lieu trouvé (« Gare d'Austerlitz », « 5 Avenue Buffon 45100 Orléans »), pour le vérifier. */
  nom: string | null;
}

/** Accès au service de géocodage (le vrai, ou un faux dans les tests). */
export interface SourceGeocodage {
  nom: string;
  chercher(q: string, mode: Mode): Promise<Candidat[]>;
}

const Point = z.object({ coordinates: z.tuple([z.number(), z.number()]) });
const ReponseAdresses = z.object({
  features: z.array(
    z.object({
      geometry: Point,
      properties: z.object({
        type: z.string(),
        score: z.number(),
        depcode: z.string().optional(),
        city: z.string().optional(),
        label: z.string().optional(),
      }),
    }),
  ),
});
/** Index des points d'intérêt : listes là où l'index des adresses a des valeurs simples. */
const ReponsePoi = z.object({
  features: z.array(
    z.object({
      geometry: Point,
      properties: z.object({
        category: z.array(z.string()).default([]),
        score: z.number(),
        depcode: z.array(z.string()).default([]),
        city: z.array(z.string()).default([]),
        toponym: z.string().optional(),
      }),
    }),
  ),
});

/** Candidats demandés : un nom comme « Billy » existe dans plusieurs départements, le bon n'est pas toujours premier. */
const NB_CANDIDATS = 10;

async function appelerIgn(parametres: Record<string, string>): Promise<unknown> {
  const url = new URL('/geocodage/search', origine('geocodage'));
  for (const [cle, valeur] of Object.entries({ ...parametres, limit: String(NB_CANDIDATS) })) {
    url.searchParams.set(cle, valeur);
  }
  const r = await obtenir(url, 'application/json');
  if (r.statut !== 200) throw new IndisponibleError(`Géocodage : HTTP ${r.statut}`);
  try {
    return JSON.parse(r.texte);
  } catch {
    throw new IndisponibleError('Géocodage : réponse non JSON');
  }
}

function lire<T>(schema: z.ZodType<T>, json: unknown): T {
  const lu = schema.safeParse(json);
  if (!lu.success) throw new IndisponibleError('Géocodage : réponse au format inattendu');
  return lu.data;
}

export const sourceIgn: SourceGeocodage = {
  nom: 'ign',
  async chercher(q, mode) {
    if (mode === 'mairie' || mode === 'poi') {
      const json = await appelerIgn({ q: mode === 'mairie' ? `mairie ${q}` : q, index: 'poi' });
      return lire(ReponsePoi, json).features.map(({ geometry, properties: p }) => ({
        longitude: geometry.coordinates[0],
        latitude: geometry.coordinates[1],
        type: p.category.includes('mairie') ? 'mairie' : (p.category[0] ?? ''),
        score: p.score,
        departement: p.depcode[0] ?? null,
        // Plusieurs communes possibles, dans un ordre variable (« Paris 13e Arrondissement », « Paris ») :
        // la plus générale a le nom le plus court.
        commune: p.city.reduce<string | null>((a, c) => (a === null || c.length < a.length ? c : a), null),
        nom: p.toponym ?? null,
      }));
    }
    const json = await appelerIgn(mode === 'commune' ? { q, type: 'municipality' } : { q });
    return lire(ReponseAdresses, json).features.map(({ geometry, properties: p }) => ({
      longitude: geometry.coordinates[0],
      latitude: geometry.coordinates[1],
      type: p.type,
      score: p.score,
      departement: p.depcode ?? null,
      commune: p.city ?? null,
      nom: p.label ?? null,
    }));
  },
};

/**
 * Règles d'acceptation par mode, relevées sur les lieux réels : en dessous de 0,6 la voie trouvée est souvent une
 * autre ; une mairie a un score bas (le nom complet est « Mairie de … ») mais doit être celle de la commune cherchée.
 */
const ACCEPTE: Record<Mode, (c: Candidat, q: string) => boolean> = {
  adresse: (c) => ['housenumber', 'street'].includes(c.type) && c.score >= 0.6,
  mairie: (c, q) => c.type === 'mairie' && c.commune !== null && cleComparaison(c.commune) === cleComparaison(q),
  commune: (c) => c.type === 'municipality' && c.score >= 0.5,
  poi: (c) => c.score >= 0.5,
};

/** Premier candidat fiable pour la requête, et dans le département de l'offre s'il est connu. */
export function choisir(candidats: Candidat[], requete: Requete, departement: string | null): Point | null {
  const retenu = candidats.find(
    (c) =>
      ACCEPTE[requete.mode](c, requete.q) &&
      (departement === null || c.departement?.toUpperCase() === departement.toUpperCase()),
  );
  return retenu ? { latitude: retenu.latitude, longitude: retenu.longitude } : null;
}

const INTROUVABLE: Geo = { latitude: null, longitude: null, precision_geo: null };

export class Geocodeur {
  readonly depot: Depot;
  readonly source: SourceGeocodage;
  readonly jour: string;
  /** Message de la première panne du service ; plus aucun appel ensuite. */
  panne: string | null = null;
  /** Appels faits au service (contrôle « 1 appel par lieu »). */
  appels = 0;

  constructor(depot: Depot, source: SourceGeocodage, jour: string) {
    this.depot = depot;
    this.source = source;
    this.jour = jour;
  }

  /** Coordonnées d'un lieu ; `undefined` si le service est en panne (rien n'est mis en cache). */
  async lieu(lieu: Lieu): Promise<Geo | undefined> {
    const cle = cleLieu(lieu);
    const cache = this.depot.lireGeocodage(cle);
    if (cache) return { latitude: cache.latitude, longitude: cache.longitude, precision_geo: cache.precision_geo };
    for (const requete of requetesLieu(lieu)) {
      const geo = await this.requete(requete, lieu.departement);
      if (geo === undefined) return undefined;
      if (geo.latitude !== null) return this.memoriser(cle, geo);
    }
    return this.memoriser(cle, INTROUVABLE);
  }

  /**
   * Résultat d'une requête, mis en cache lui aussi : la mairie d'Orléans n'est cherchée qu'une fois pour tous les
   * lieux qui y mènent (« ORLEANS (45) », « Université d'Orléans »…).
   */
  private async requete(requete: Requete, departement: string | null): Promise<Geo | undefined> {
    const cle = `requete:${requete.mode}:${departement ?? ''}:${cleComparaison(requete.q)}`;
    const cache = this.depot.lireGeocodage(cle);
    if (cache) return { latitude: cache.latitude, longitude: cache.longitude, precision_geo: cache.precision_geo };
    const candidats = await this.chercher(requete);
    if (candidats === undefined) return undefined;
    const point = choisir(candidats, requete, departement);
    return this.memoriser(cle, point ? { ...point, precision_geo: precisionDe(requete.mode) } : INTROUVABLE);
  }

  private async chercher(requete: Requete): Promise<Candidat[] | undefined> {
    if (this.panne) return undefined;
    try {
      this.appels++;
      return await this.source.chercher(requete.q, requete.mode);
    } catch (e) {
      if (!(e instanceof IndisponibleError || e instanceof BlocageError)) throw e;
      this.panne = e.message;
      return undefined;
    }
  }

  private memoriser(cle: string, geo: Geo): Geo {
    this.depot.ecrireGeocodage({ cle_lieu: cle, ...geo, source: this.source.nom, date: this.jour });
    return geo;
  }
}
