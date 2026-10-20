// Transitous (moteur MOTIS 2), gratuit, sans clé, tenu par des bénévoles. Conditions d'usage
// (https://transitous.org/api/) : projet libre et non commercial, user-agent avec un contact, usage léger,
// attribution https://transitous.org/sources/ visible. Le cache de trajets limite les appels aux lieux nouveaux.
import { z } from 'zod';
import { IndisponibleError } from '../erreurs.ts';
import { obtenir } from '../http.ts';
import { origine } from '../securite/urls.ts';
import type { Point } from './lieux.ts';
import { arrondir5, type FournisseurTrajet, type ResultatTrajet } from './trajets.ts';

const Itineraire = z.object({
  startTime: z.string(),
  endTime: z.string(),
  transfers: z.number().int().min(0).optional(),
});
const ReponsePlan = z.object({
  itineraries: z.array(Itineraire),
  /** Trajet direct (à pied) quand il est proposé. */
  direct: z.array(Itineraire).default([]),
});

const coordonnees = (p: Point) => `${p.latitude},${p.longitude}`;

/**
 * Seuls comptent les départs dans les 2 heures qui suivent l'heure demandée : sans train ni car le matin, MOTIS
 * propose l'après-midi (« 660 min » vers une commune rurale), ce qui n'a pas de sens pour un trajet domicile-travail.
 */
export const FENETRE_DEPART_MS = 2 * 3_600_000;

/**
 * Itinéraire retenu : l'arrivée la plus tôt parmi les départs de la fenêtre ; durée de porte à porte (marche
 * comprise, sans l'attente avant de partir). `null` si aucun départ dans la fenêtre.
 */
export function meilleurItineraire(reponse: z.infer<typeof ReponsePlan>, quand: Date): ResultatTrajet | null {
  const debut = quand.getTime();
  const candidats = [
    ...reponse.itineraries.map((i) => ({ ...i, correspondances: i.transfers ?? 0 })),
    ...reponse.direct.map((i) => ({ ...i, correspondances: 0 })),
  ]
    .map((i) => ({
      depart: Date.parse(i.startTime),
      arrivee: Date.parse(i.endTime),
      correspondances: i.correspondances,
    }))
    .filter((i) => i.depart >= debut - 60_000 && i.depart <= debut + FENETRE_DEPART_MS && i.arrivee > i.depart);
  if (!candidats.length) return null;
  const premier = candidats.reduce((a, b) => (b.arrivee < a.arrivee ? b : a));
  return {
    duree_min: arrondir5((premier.arrivee - premier.depart) / 60_000),
    nb_correspondances: premier.correspondances,
  };
}

export const transitous: FournisseurTrajet = {
  nom: 'transitous',
  async calculer(depart, arrivee, quand) {
    const url = new URL('/api/v5/plan', origine('trajets'));
    url.searchParams.set('fromPlace', coordonnees(depart));
    url.searchParams.set('toPlace', coordonnees(arrivee));
    url.searchParams.set('time', quand.toISOString());
    url.searchParams.set('arriveBy', 'false');
    const r = await obtenir(url, 'application/json');
    if (r.statut !== 200) throw new IndisponibleError(`Transitous : HTTP ${r.statut}`);
    let json: unknown;
    try {
      json = JSON.parse(r.texte);
    } catch {
      throw new IndisponibleError('Transitous : réponse non JSON');
    }
    const lu = ReponsePlan.safeParse(json);
    if (!lu.success) throw new IndisponibleError('Transitous : réponse au format inattendu');
    return meilleurItineraire(lu.data, quand);
  },
};
