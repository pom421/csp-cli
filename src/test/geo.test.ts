import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { Depot } from '../db/depot.ts';
import type { ChampsCode } from '../db/schema.ts';
import { IndisponibleError } from '../erreurs.ts';
import { choisir, Geocodeur, sourceIgn, type Candidat, type SourceGeocodage } from '../geo/geocodage.ts';
import {
  cleLieu,
  communeApresPreposition,
  communeProbable,
  nettoyer,
  partieAdresse,
  requetesLieu,
  type Lieu,
} from '../geo/lieux.ts';
import {
  arrondir5,
  calculerTrajets,
  cleDestination,
  instantParis,
  jourReference,
  pointDeDepart,
  trajetEnCache,
  type FournisseurTrajet,
} from '../geo/trajets.ts';
import { meilleurItineraire, transitous } from '../geo/transitous.ts';
import { demarrer } from './faux-site.ts';

const ORLEANS = { latitude: 47.9029, longitude: 1.9093 };
const BLOIS = { latitude: 47.5861, longitude: 1.3359 };
const OLIVET = { latitude: 47.8634, longitude: 1.9003 };

const lieu = (adresse: string | null, l: Partial<Lieu> = {}): Lieu => {
  const m = adresse ? /\b(\d{5})\s+(.+)$/.exec(adresse) : null;
  return { adresse, code_postal: m?.[1] ?? null, commune: m?.[2] ?? null, departement: '45', ...l };
};

describe('lieux → requêtes de géocodage', () => {
  it('retire CEDEX, département entre parenthèses et pays', () => {
    expect(nettoyer('ORLEANS CEDEX 2')).toBe('ORLEANS');
    expect(nettoyer('Loiret (45), France')).toBe('Loiret');
    expect(nettoyer('BLOIS (41000)')).toBe('BLOIS');
  });

  it('garde la partie adresse d’un lieu précédé du nom du service', () => {
    expect(partieAdresse('DDETSPP - PÔLE ADM P. CHARLOT - 31 Mail Charlot - 41000 BLOIS')).toBe(
      '31 Mail Charlot 41000 BLOIS',
    );
    expect(partieAdresse('Avenue Buffon - 45100 ORLEANS')).toBe('Avenue Buffon 45100 ORLEANS');
  });

  it('devine la commune quand la page n’a pas de code postal', () => {
    expect(communeProbable(lieu('PREFECTURE DE LOIR-ET-CHER - BLOIS (41000)'))).toBe('BLOIS');
    expect(communeProbable(lieu('5 AVENUE BUFFON 45064'))).toBeNull();
    expect(communeApresPreposition("Rectorat de l'académie de Nice")).toBe('Nice');
    expect(communeApresPreposition("Université d'Orléans")).toBe('Orléans');
  });

  it.each([
    [
      '202 Boulevard Duhamel du Monceau 45160 OLIVET',
      ['adresse:202 Boulevard Duhamel du Monceau 45160 OLIVET', 'mairie:OLIVET', 'commune:OLIVET'],
    ],
    [
      '5 AVENUE BUFFON 45064 ORLEANS CEDEX 2',
      ['adresse:5 AVENUE BUFFON 45064 ORLEANS', 'mairie:ORLEANS', 'commune:ORLEANS'],
    ],
    ['5 AVENUE BUFFON 45064', ['adresse:5 AVENUE BUFFON 45064']],
    ['Orléans', ['mairie:Orléans', 'commune:Orléans']],
    ['Loiret (45), France', ['mairie:Loiret', 'commune:Loiret']],
    [
      "Université d'Orléans",
      ["mairie:Université d'Orléans", "commune:Université d'Orléans", 'mairie:Orléans', 'commune:Orléans'],
    ],
  ])('%s', (texte, attendu) => {
    expect(requetesLieu(lieu(texte)).map((r) => `${r.mode}:${r.q}`)).toEqual(attendu);
  });

  it('donne la même clé de cache aux variantes d’écriture d’un même lieu', () => {
    expect(cleLieu(lieu('75 RUE DU PARC 45000 ORLEANS'))).toBe(cleLieu(lieu('75 rue du Parc 45000 Orléans')));
    expect(cleLieu(lieu('Billy', { departement: '41' }))).not.toBe(cleLieu(lieu('Billy', { departement: '03' })));
  });
});

const candidat = (c: Partial<Candidat>): Candidat => ({
  ...ORLEANS,
  type: 'municipality',
  score: 0.9,
  departement: '45',
  commune: 'Orléans',
  nom: null,
  ...c,
});

describe('choix du candidat', () => {
  it('écarte les homonymes d’un autre département', () => {
    const billy03 = candidat({ latitude: 46.4, departement: '03' });
    const billy41 = candidat({ latitude: 47.3, departement: '41' });
    expect(choisir([billy03, billy41], { q: 'Billy', mode: 'commune' }, '41')).toMatchObject({ latitude: 47.3 });
    expect(choisir([billy03], { q: 'Billy', mode: 'commune' }, '41')).toBeNull();
  });

  it('n’accepte que la mairie de la commune cherchée', () => {
    const mairie = (commune: string) => candidat({ type: 'mairie', score: 0.36, commune });
    const req = { q: 'ORLEANS', mode: 'mairie' as const };
    expect(choisir([mairie('Orléat'), mairie('Orléans')], req, '45')).not.toBeNull();
    expect(choisir([mairie('Orléat')], req, null)).toBeNull();
    expect(choisir([candidat({ type: 'station de tramway' })], req, '45')).toBeNull();
  });

  it('exige une voie pour une adresse, et un score suffisant', () => {
    const req = { q: '5 avenue Buffon 45100 Orléans', mode: 'adresse' as const };
    expect(choisir([candidat({ type: 'municipality' })], req, '45')).toBeNull();
    expect(choisir([candidat({ type: 'street', score: 0.58 })], req, '45')).toBeNull();
    expect(choisir([candidat({ type: 'housenumber', score: 0.7 })], req, '45')).not.toBeNull();
  });
});

/** Faux géocodeur : requête → candidats ; garde la trace des requêtes. */
function fauxGeocodage(reponses: Record<string, Candidat[]>, panne = false) {
  const requetes: string[] = [];
  const source: SourceGeocodage = {
    nom: 'faux',
    async chercher(q, mode) {
      requetes.push(mode === 'commune' ? q : `${mode}:${q}`);
      if (panne) throw new IndisponibleError('géocodeur injoignable');
      return reponses[mode === 'commune' ? q : `${mode}:${q}`] ?? [];
    },
  };
  return { source, requetes };
}

let depot: Depot;
beforeEach(() => {
  depot = new Depot(':memory:');
});
afterEach(() => depot.fermer());

describe('géocodeur', () => {
  it('un appel par lieu : deux offres au même endroit, puis le cache', async () => {
    const { source, requetes } = fauxGeocodage({ 'mairie:ORLEANS': [candidat({ type: 'mairie' })] });
    const g = new Geocodeur(depot, source, '2026-10-20');
    const a = await g.lieu(lieu('ORLEANS (45)'));
    const b = await g.lieu(lieu('Orléans (45)'));
    expect(a).toEqual({ ...ORLEANS, precision_geo: 'commune' });
    expect(b).toEqual(a);
    expect(requetes).toEqual(['mairie:ORLEANS']);
  });

  it('partage le résultat d’une requête entre lieux différents de la même commune', async () => {
    const { source, requetes } = fauxGeocodage({ 'mairie:Orléans': [candidat({ type: 'mairie' })] });
    const g = new Geocodeur(depot, source, '2026-10-20');
    await g.lieu(lieu('Orléans'));
    expect(await g.lieu(lieu("Tribunal administratif d'Orléans"))).toMatchObject(ORLEANS);
    expect(requetes).toEqual([
      'mairie:Orléans',
      "mairie:Tribunal administratif d'Orléans",
      "Tribunal administratif d'Orléans",
    ]);
  });

  it('se rabat sur le centre de la commune sans mairie connue', async () => {
    const { source, requetes } = fauxGeocodage({
      'Lamotte-Beuvron': [candidat({ latitude: 47.6, departement: '45' })],
    });
    const geo = await new Geocodeur(depot, source, '2026-10-20').lieu(lieu('Lamotte-Beuvron'));
    expect(geo).toMatchObject({ latitude: 47.6, precision_geo: 'commune' });
    expect(requetes).toEqual(['mairie:Lamotte-Beuvron', 'Lamotte-Beuvron']);
  });

  it('se rabat sur la commune quand l’adresse n’est pas fiable', async () => {
    const { source, requetes } = fauxGeocodage({
      'adresse:RUE DE LA BASE 45140 BOULAY-LES-BARRES': [candidat({ type: 'street', score: 0.58 })],
      'mairie:BOULAY-LES-BARRES': [candidat({ latitude: 47.98, type: 'mairie', commune: 'Boulay-les-Barres' })],
    });
    const geo = await new Geocodeur(depot, source, '2026-10-20').lieu(lieu('RUE DE LA BASE 45140 BOULAY-LES-BARRES'));
    expect(geo).toMatchObject({ latitude: 47.98, precision_geo: 'commune' });
    expect(requetes).toHaveLength(2);
  });

  it('met en cache un lieu introuvable : pas de nouvel appel le lendemain', async () => {
    const { source, requetes } = fauxGeocodage({});
    await new Geocodeur(depot, source, '2026-10-20').lieu(lieu('Loiret (45), France'));
    const geo = await new Geocodeur(depot, source, '2026-10-21').lieu(lieu('Loiret (45), France'));
    expect(geo).toEqual({ latitude: null, longitude: null, precision_geo: null });
    expect(requetes).toEqual(['mairie:Loiret', 'Loiret']);
  });

  it('en panne : rien en cache, plus aucun appel de la journée', async () => {
    const { source, requetes } = fauxGeocodage({}, true);
    const g = new Geocodeur(depot, source, '2026-10-20');
    expect(await g.lieu(lieu('Orléans'))).toBeUndefined();
    expect(await g.lieu(lieu('Blois'))).toBeUndefined();
    expect(g.panne).toMatch('injoignable');
    expect(requetes).toEqual(['mairie:Orléans']);
    expect(depot.lireGeocodage(cleLieu(lieu('Orléans')))).toBeUndefined();
  });
});

describe('date et heure de référence', () => {
  it('prend le prochain mardi, jamais le jour même', () => {
    expect(jourReference('2026-10-20')).toBe('2026-10-27'); // mardi → mardi suivant
    expect(jourReference('2026-10-19')).toBe('2026-10-20'); // lundi
    expect(jourReference('2026-10-25')).toBe('2026-10-27'); // dimanche
  });

  it('saute les mardis fériés', () => {
    expect(jourReference('2029-04-27')).toBe('2029-05-15'); // 1er et 8 mai 2029 tombent un mardi
  });

  it('convertit l’heure de Paris, été comme hiver', () => {
    expect(instantParis('2026-10-27', '08:00').toISOString()).toBe('2026-10-27T07:00:00.000Z');
    expect(instantParis('2026-07-07', '08:00').toISOString()).toBe('2026-07-07T06:00:00.000Z');
  });

  it('arrondit aux 5 minutes', () => {
    expect([arrondir5(31), arrondir5(33), arrondir5(1)]).toEqual([30, 35, 5]);
  });
});

describe('réponse de Transitous', () => {
  const quand = new Date('2026-10-27T07:00:00Z');
  it('retient l’arrivée la plus tôt, attente du premier passage comprise', () => {
    const r = meilleurItineraire(
      {
        itineraries: [
          { startTime: '2026-10-27T07:01:00Z', endTime: '2026-10-27T07:37:00Z', transfers: 0 },
          { startTime: '2026-10-27T07:05:00Z', endTime: '2026-10-27T07:32:00Z', transfers: 1 },
        ],
        direct: [],
      },
      quand,
    );
    expect(r).toEqual({ duree_min: 25, nb_correspondances: 1 });
  });

  it('ignore les départs au-delà de 2 heures (car de l’après-midi)', () => {
    const apresMidi = { startTime: '2026-10-27T12:31:00Z', endTime: '2026-10-27T13:02:00Z', transfers: 0 };
    expect(meilleurItineraire({ itineraries: [apresMidi], direct: [] }, quand)).toBeNull();
    const neufHeures = { startTime: '2026-10-27T08:50:00Z', endTime: '2026-10-27T09:30:00Z', transfers: 2 };
    expect(meilleurItineraire({ itineraries: [apresMidi, neufHeures], direct: [] }, quand)).toEqual({
      duree_min: 40,
      nb_correspondances: 2,
    });
  });

  it('compte un trajet à pied direct, et rend null sans itinéraire', () => {
    const aPied = { startTime: '2026-10-27T07:00:00Z', endTime: '2026-10-27T07:12:00Z' };
    expect(meilleurItineraire({ itineraries: [], direct: [aPied] }, quand)).toEqual({
      duree_min: 10,
      nb_correspondances: 0,
    });
    expect(meilleurItineraire({ itineraries: [], direct: [] }, quand)).toBeNull();
  });
});

describe('services réels contre un faux serveur', () => {
  let serveur: Awaited<ReturnType<typeof demarrer>> | undefined;
  afterEach(async () => {
    await serveur?.fermer();
    delete process.env.CSP_GEOCODAGE_URL;
    delete process.env.CSP_TRAJETS_URL;
    delete process.env.CSP_DELAI_MS;
  });

  it('interroge la Géoplateforme et lit ses candidats', async () => {
    serveur = await demarrer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          features: [
            {
              geometry: { coordinates: [1.9093, 47.9029] },
              properties: { type: 'municipality', score: 0.96, depcode: '45', city: 'Orléans' },
            },
          ],
        }),
      );
    });
    process.env.CSP_GEOCODAGE_URL = serveur.url;
    process.env.CSP_DELAI_MS = '0';
    const c = await sourceIgn.chercher('Orléans', 'commune');
    expect(c).toEqual([
      { ...ORLEANS, type: 'municipality', score: 0.96, departement: '45', commune: 'Orléans', nom: null },
    ]);
    const url = new URL(serveur.requetes[0].url, serveur.url);
    expect(url.pathname).toBe('/geocodage/search');
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: 'Orléans', limit: '10', type: 'municipality' });
    expect(serveur.requetes[0].userAgent).toMatch(/^csp-cli\/.*https:\/\/github\.com\//);
  });

  it('interroge Transitous en heure UTC et classe une erreur serveur en panne', async () => {
    let statut = 200;
    serveur = await demarrer((req, res) => {
      res.writeHead(statut, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          itineraries: [{ startTime: '2026-10-27T07:01:00Z', endTime: '2026-10-27T07:41:00Z', transfers: 2 }],
          direct: [],
        }),
      );
    });
    process.env.CSP_TRAJETS_URL = serveur.url;
    process.env.CSP_DELAI_MS = '0';
    const quand = new Date('2026-10-27T07:00:00Z');
    expect(await transitous.calculer(ORLEANS, BLOIS, quand)).toEqual({ duree_min: 40, nb_correspondances: 2 });
    const url = new URL(serveur.requetes[0].url, serveur.url);
    expect(url.pathname).toBe('/api/v5/plan');
    expect(url.searchParams.get('fromPlace')).toBe('47.9029,1.9093');
    expect(url.searchParams.get('time')).toBe('2026-10-27T07:00:00.000Z');
    statut = 502;
    await expect(transitous.calculer(ORLEANS, BLOIS, quand)).rejects.toBeInstanceOf(IndisponibleError);
  });
});

describe('point de départ', () => {
  it('accepte des coordonnées sans appeler le géocodeur', async () => {
    const { source, requetes } = fauxGeocodage({});
    expect(await pointDeDepart(source, '47.9, 1.91')).toMatchObject({ point: { latitude: 47.9, longitude: 1.91 } });
    expect(requetes).toEqual([]);
  });

  it('cherche un lieu nommé parmi les points d’intérêt et rend son libellé', async () => {
    const { source, requetes } = fauxGeocodage({
      "poi:Gare d'Austerlitz": [
        candidat({
          type: 'gare',
          latitude: 48.8416,
          longitude: 2.3662,
          departement: '75',
          commune: 'Paris',
          nom: "Gare d'Austerlitz",
        }),
      ],
    });
    const o = await pointDeDepart(source, "Gare d'Austerlitz");
    expect(o).toMatchObject({ point: { latitude: 48.8416 }, libelle: "Gare d'Austerlitz (Paris)" });
    expect(o.cle).toMatch(/^[0-9a-f]{64}$/);
    expect(requetes).toEqual(["poi:Gare d'Austerlitz"]);
  });

  it('écarte un homonyme hors du département demandé (« Gare de Lyon (75) »)', async () => {
    const lyon = candidat({ type: 'gare', departement: '69', nom: 'Gare de Lyon-Gorge-de-Loup' });
    const paris = candidat({
      type: 'gare',
      latitude: 48.8448,
      departement: '75',
      nom: 'Gare de Lyon',
      commune: 'Paris',
    });
    const { source } = fauxGeocodage({ 'poi:Gare de Lyon': [lyon, paris] });
    expect((await pointDeDepart(source, 'Gare de Lyon (75)')).libelle).toBe('Gare de Lyon (Paris)');
    expect((await pointDeDepart(source, 'Gare de Lyon')).libelle).toBe('Gare de Lyon-Gorge-de-Loup (Orléans)');
  });

  it('cherche une adresse (avec code postal) d’abord parmi les adresses ; même empreinte quelle que soit la casse', async () => {
    const adresse = [candidat({ type: 'housenumber', nom: '1 Rue Fictive 45000 Orléans' })];
    const { source, requetes } = fauxGeocodage({
      'adresse:1 rue Fictive 45000 Orléans': adresse,
      'adresse:1 RUE FICTIVE 45000 ORLÉANS': adresse,
    });
    const o = await pointDeDepart(source, '1 rue Fictive 45000 Orléans');
    expect(o).toMatchObject({ point: ORLEANS, libelle: '1 Rue Fictive 45000 Orléans' });
    expect(requetes).toEqual(['adresse:1 rue Fictive 45000 Orléans']);
    expect(o.cle).toBe((await pointDeDepart(source, '1 RUE FICTIVE 45000 ORLÉANS')).cle);
  });

  it('introuvable : erreur qui explique comment préciser', async () => {
    const { source } = fauxGeocodage({});
    await expect(pointDeDepart(source, 'Nulle part')).rejects.toThrow(/introuvable.*Gare de Lyon \(75\)/);
  });
});

describe('calcul des trajets avec cache', () => {
  function offre(id: string, p: typeof ORLEANS | null) {
    depot.enregistrerOffre({ id_offre: id, url: 'https://x/', titre: id } as ChampsCode, '2026-10-20');
    if (p) depot.poserGeo(id, { ...p, precision_geo: 'commune' });
    return depot.obtenirOffre(id)!;
  }
  function fauxTrajets(duree: number | null, panneApres = Infinity) {
    const appels: string[] = [];
    const fournisseur: FournisseurTrajet = {
      nom: 'faux',
      async calculer(_d, a) {
        if (appels.length >= panneApres) throw new IndisponibleError('Transitous : HTTP 503');
        appels.push(cleDestination(a));
        return duree === null ? null : { duree_min: duree, nb_correspondances: 1 };
      },
    };
    return { fournisseur, appels };
  }
  const origine = { cle: 'o'.repeat(64), point: ORLEANS, libelle: 'Orléans' };
  const ctx = (fournisseur: FournisseurTrajet, jour = '2026-10-20') => ({
    depot,
    fournisseur,
    origine,
    jour,
    heure: '08:00',
  });

  it('un appel par destination, puis le cache ; offres sans coordonnées comptées à part', async () => {
    const offres = [offre('a', OLIVET), offre('b', OLIVET), offre('c', BLOIS), offre('d', null)];
    const { fournisseur, appels } = fauxTrajets(45);
    expect(await calculerTrajets(ctx(fournisseur), offres)).toMatchObject({
      calcules: 2,
      en_cache: 1,
      non_localisees: 1,
      panne: null,
    });
    expect(appels).toHaveLength(2);
    expect(await calculerTrajets(ctx(fournisseur), offres)).toMatchObject({ calcules: 0, en_cache: 3 });
    expect(trajetEnCache(depot, origine, offres[0], '08:00')).toEqual({ duree_min: 45, nb_correspondances: 1 });
    expect(trajetEnCache(depot, origine, offres[3], '08:00')).toBeUndefined();
  });

  it('met « aucun itinéraire » en cache, et recalcule au-delà de 90 jours', async () => {
    const offres = [offre('a', BLOIS)];
    await calculerTrajets(ctx(fauxTrajets(null).fournisseur), offres);
    expect(trajetEnCache(depot, origine, offres[0], '08:00')).toBeNull();
    const { fournisseur, appels } = fauxTrajets(50);
    await calculerTrajets(ctx(fournisseur, '2027-01-17'), offres);
    expect(appels).toHaveLength(0);
    await calculerTrajets(ctx(fournisseur, '2027-01-19'), offres);
    expect(trajetEnCache(depot, origine, offres[0], '08:00')).toMatchObject({ duree_min: 50 });
  });

  it('s’arrête à la première panne sans échouer ; le reste sera fait au prochain passage', async () => {
    const offres = [offre('a', OLIVET), offre('b', BLOIS)];
    const b = await calculerTrajets(ctx(fauxTrajets(45, 1).fournisseur), offres);
    expect(b).toMatchObject({ calcules: 1, panne: 'Transitous : HTTP 503' });
    expect(trajetEnCache(depot, origine, offres[1], '08:00')).toBeUndefined();
  });
});

describe('base temporaire', () => {
  it('garde le cache de géocodage entre deux ouvertures', async () => {
    const chemin = join(mkdtempSync(join(tmpdir(), 'csp-')), 'csp.sqlite');
    const { source, requetes } = fauxGeocodage({
      'mairie:Blois': [candidat({ ...BLOIS, type: 'mairie', commune: 'Blois', departement: '41' })],
    });
    for (const jour of ['2026-10-20', '2026-10-21']) {
      const d = new Depot(chemin);
      await new Geocodeur(d, source, jour).lieu(lieu('Blois', { departement: '41' }));
      d.fermer();
    }
    expect(requetes).toEqual(['mairie:Blois']);
  });
});
