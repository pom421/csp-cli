// Trajets des offres actives : en fin de collecte, ou par `csp trajets` (offres pas encore localisées,
// changement d'adresse de départ avec --recalculer).
import { chemins, heureDepart } from './config.ts';
import { Depot } from './db/depot.ts';
import type { Offre } from './db/schema.ts';
import { BlocageError, IndisponibleError, UserError } from './erreurs.ts';
import { Geocodeur, sourceIgn, type SourceGeocodage } from './geo/geocodage.ts';
import {
  calculerTrajets,
  origineTrajet,
  trajetEnCache,
  type BilanTrajets,
  type FournisseurTrajet,
  type ResultatTrajet,
} from './geo/trajets.ts';
import { transitous } from './geo/transitous.ts';

export interface OptionsTrajets {
  /** Jour de l'exécution (AAAA-MM-JJ, Paris). */
  jour: string;
  geocodage?: SourceGeocodage;
  fournisseur?: FournisseurTrajet;
  /** Adresse de départ ; par défaut CSP_ORIGINE_TRAJET. */
  origine?: string;
}

const bilanVide = (fournisseur: string, panne: string | null): BilanTrajets => ({
  fournisseur,
  calcules: 0,
  en_cache: 0,
  sans_itineraire: 0,
  non_localisees: 0,
  panne,
});

/**
 * Trajets des offres actives en fin de collecte. `null` sans adresse de départ. Une panne (géocodage de l'origine,
 * Transitous) est rapportée dans le bilan sans faire échouer la collecte.
 */
export async function trajetsDuJour(depot: Depot, options: OptionsTrajets): Promise<BilanTrajets | null> {
  const fournisseur = options.fournisseur ?? transitous;
  const heure = heureDepart();
  let origine;
  try {
    origine = await origineTrajet(options.geocodage ?? sourceIgn, options.origine ?? process.env.CSP_ORIGINE_TRAJET);
  } catch (e) {
    // Adresse introuvable (configuration) ou géocodeur en panne : la collecte est faite, seuls les trajets manquent.
    if (!(e instanceof IndisponibleError || e instanceof BlocageError || e instanceof UserError)) throw e;
    return bilanVide(fournisseur.nom, `adresse de départ non géocodée : ${e.message}`);
  }
  if (!origine) return null;
  return calculerTrajets({ depot, fournisseur, origine, jour: options.jour, heure }, depot.listerOffres('active'));
}

export interface LigneTrajet {
  id_offre: string;
  titre: string;
  commune: string | null;
  /** `undefined` : non calculé ; `null` : aucun itinéraire. */
  trajet: ResultatTrajet | null | undefined;
}

export interface ResultatTrajets {
  localisation: { offres: number; localisees: number; appels: number; panne: string | null };
  trajets: BilanTrajets;
  offres: LigneTrajet[];
}

/** Ordre d'affichage : trajets connus du plus court au plus long, puis sans itinéraire, puis non calculés. */
const rang = (t: LigneTrajet['trajet']) => (t ? t.duree_min : t === null ? 1e6 : 2e6);

/** `csp trajets` : localise les offres actives qui ne le sont pas encore, puis calcule les trajets manquants. */
export async function trajets(
  options: OptionsTrajets & { recalculer?: boolean; base?: string },
): Promise<ResultatTrajets> {
  const depot = new Depot(options.base ?? chemins().base);
  try {
    const geocodeur = new Geocodeur(depot, options.geocodage ?? sourceIgn, options.jour);
    const aLocaliser = depot.offresSansGeo();
    let localisees = 0;
    for (const o of aLocaliser) {
      const geo = await geocodeur.lieu(o);
      if (geo === undefined) break;
      depot.poserGeo(o.id_offre, geo);
      if (geo.latitude !== null) localisees++;
    }
    const heure = heureDepart();
    const origine = await origineTrajet(geocodeur.source, options.origine ?? process.env.CSP_ORIGINE_TRAJET);
    if (!origine) throw new UserError('CSP_ORIGINE_TRAJET vide : adresse de départ à définir dans le .env');
    if (options.recalculer) depot.viderTrajets(origine.cle);
    const fournisseur = options.fournisseur ?? transitous;
    const actives = depot.listerOffres('active');
    const bilan = await calculerTrajets({ depot, fournisseur, origine, jour: options.jour, heure }, actives);
    const offres = actives
      .map((o: Offre) => ({
        id_offre: o.id_offre,
        titre: o.titre,
        commune: o.commune ?? o.adresse,
        trajet: trajetEnCache(depot, origine, o, heure),
      }))
      .sort((a, b) => rang(a.trajet) - rang(b.trajet) || a.id_offre.localeCompare(b.id_offre));
    return {
      localisation: { offres: aLocaliser.length, localisees, appels: geocodeur.appels, panne: geocodeur.panne },
      trajets: bilan,
      offres,
    };
  } finally {
    depot.fermer();
  }
}

export function formaterTrajets(b: BilanTrajets): string {
  const ligne =
    `Trajets (${b.fournisseur}) : ${b.calcules} calculé(s), ${b.en_cache} en cache, ` +
    `${b.sans_itineraire} sans itinéraire, ${b.non_localisees} offre(s) sans coordonnées`;
  return b.panne ? `${ligne}\n  arrêtés, repris au prochain passage : ${b.panne}` : ligne;
}

const duree = (t: LigneTrajet['trajet']) =>
  t === undefined
    ? 'non calculé'
    : t === null
      ? 'aucun itinéraire'
      : `${t.duree_min} min, ${t.nb_correspondances} correspondance(s)`;

export function formaterResultatTrajets(r: ResultatTrajets): string {
  const l = r.localisation;
  const lignes = [
    `Localisation : ${l.localisees}/${l.offres} offre(s) localisée(s), ${l.appels} appel(s) au géocodeur`,
  ];
  if (l.panne) lignes.push(`  géocodeur en panne : ${l.panne}`);
  lignes.push(
    formaterTrajets(r.trajets),
    '',
    ...r.offres.map((o) => `  ${duree(o.trajet)} — ${o.titre} — ${o.commune ?? '?'}`),
  );
  return lignes.join('\n');
}
