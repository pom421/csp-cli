// Trajets depuis le point de départ de chaque recherche (`depart` dans recherches.yaml), vers les offres actives de
// cette recherche : en fin de collecte, ou par `csp trajets` (offres pas encore localisées, --recalculer).
import { chemins, heureDepart, lireRecherches, type Recherche } from './config.ts';
import { Depot } from './db/depot.ts';
import { BlocageError, IndisponibleError, UserError } from './erreurs.ts';
import { Geocodeur, sourceIgn, type SourceGeocodage } from './geo/geocodage.ts';
import {
  calculerTrajets,
  pointDeDepart,
  trajetEnCache,
  type BilanTrajets,
  type FournisseurTrajet,
  type Origine,
  type ResultatTrajet,
} from './geo/trajets.ts';
import { transitous } from './geo/transitous.ts';

export interface OptionsTrajets {
  /** Jour de l'exécution (AAAA-MM-JJ, Paris). */
  jour: string;
  geocodage?: SourceGeocodage;
  fournisseur?: FournisseurTrajet;
}

export interface BilanTrajetsRecherche extends BilanTrajets {
  recherche: string;
  /** Lieu retenu pour le point de départ (`null` s'il n'a pas pu être géocodé). */
  depart: string | null;
}

/** Recherches qui ont un point de départ, chacune avec son origine géocodée (ou l'erreur rencontrée). */
async function origines(
  recherches: Recherche[],
  source: SourceGeocodage,
): Promise<{ recherche: Recherche; origine: Origine | null; erreur: string | null }[]> {
  // Un même point de départ partagé par plusieurs recherches n'est géocodé qu'une fois.
  const deja = new Map<string, Origine | string>();
  const resultat = [];
  for (const recherche of recherches.filter((r) => r.depart)) {
    const texte = recherche.depart!;
    if (!deja.has(texte)) {
      try {
        deja.set(texte, await pointDeDepart(source, texte));
      } catch (e) {
        // Lieu introuvable (configuration) ou géocodeur en panne : la collecte est faite, seuls les trajets manquent.
        if (!(e instanceof IndisponibleError || e instanceof BlocageError || e instanceof UserError)) throw e;
        deja.set(texte, e.message);
      }
    }
    const o = deja.get(texte)!;
    resultat.push(
      typeof o === 'string' ? { recherche, origine: null, erreur: o } : { recherche, origine: o, erreur: null },
    );
  }
  return resultat;
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
 * Trajets de chaque recherche qui a un point de départ, vers ses offres actives. Une panne (géocodage du départ,
 * Transitous) est rapportée dans le bilan sans faire échouer l'appelant.
 */
export async function trajetsDuJour(
  depot: Depot,
  recherches: Recherche[],
  options: OptionsTrajets,
): Promise<BilanTrajetsRecherche[]> {
  return calculerPourOrigines(depot, await origines(recherches, options.geocodage ?? sourceIgn), options);
}

async function calculerPourOrigines(
  depot: Depot,
  liste: Awaited<ReturnType<typeof origines>>,
  options: OptionsTrajets,
): Promise<BilanTrajetsRecherche[]> {
  const fournisseur = options.fournisseur ?? transitous;
  const heure = heureDepart();
  const bilans: BilanTrajetsRecherche[] = [];
  for (const { recherche, origine, erreur } of liste) {
    const bilan = origine
      ? await calculerTrajets(
          { depot, fournisseur, origine, jour: options.jour, heure },
          depot.offresActivesDe(recherche.nom),
        )
      : bilanVide(fournisseur.nom, `point de départ non géocodé : ${erreur}`);
    bilans.push({ recherche: recherche.nom, depart: origine?.libelle ?? null, ...bilan });
  }
  return bilans;
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
  recherches: (BilanTrajetsRecherche & { offres: LigneTrajet[] })[];
  /** Recherches sans point de départ. */
  sans_depart: string[];
}

/** Ordre d'affichage : trajets connus du plus court au plus long, puis sans itinéraire, puis non calculés. */
const rang = (t: LigneTrajet['trajet']) => (t ? t.duree_min : t === null ? 1e6 : 2e6);

/**
 * `csp trajets` : localise les offres actives qui ne le sont pas encore, puis calcule les trajets manquants de chaque
 * recherche. `--recalculer` oublie d'abord les trajets des points de départ actuels.
 */
export async function trajets(
  options: OptionsTrajets & { recalculer?: boolean; base?: string; recherches?: Recherche[] },
): Promise<ResultatTrajets> {
  const recherches = options.recherches ?? lireRecherches();
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
    if (!recherches.some((r) => r.depart)) {
      throw new UserError('Aucune recherche n’a de point de départ : ajouter « depart » dans recherches.yaml');
    }
    const liste = await origines(recherches, geocodeur.source);
    if (options.recalculer) {
      for (const { origine } of liste) if (origine) depot.viderTrajets(origine.cle);
    }
    const heure = heureDepart();
    const bilans = await calculerPourOrigines(depot, liste, options);
    const avecOffres = [];
    for (const { recherche, origine } of liste) {
      const bilan = bilans.find((b) => b.recherche === recherche.nom)!;
      const offres = depot
        .offresActivesDe(recherche.nom)
        .map((o) => ({
          id_offre: o.id_offre,
          titre: o.titre,
          commune: o.commune ?? o.adresse,
          trajet: origine ? trajetEnCache(depot, origine, o, heure) : undefined,
        }))
        .sort((a, b) => rang(a.trajet) - rang(b.trajet) || a.id_offre.localeCompare(b.id_offre));
      avecOffres.push({ ...bilan, offres });
    }
    return {
      localisation: { offres: aLocaliser.length, localisees, appels: geocodeur.appels, panne: geocodeur.panne },
      recherches: avecOffres,
      sans_depart: recherches.filter((r) => !r.depart).map((r) => r.nom),
    };
  } finally {
    depot.fermer();
  }
}

export function formaterTrajets(b: BilanTrajets): string {
  const ligne =
    `${b.calcules} calculé(s), ${b.en_cache} en cache, ` +
    `${b.sans_itineraire} sans itinéraire, ${b.non_localisees} offre(s) sans coordonnées`;
  return b.panne ? `${ligne}\n    arrêtés, repris au prochain passage : ${b.panne}` : ligne;
}

/** Une ligne (et éventuellement une panne) par recherche qui a un point de départ. */
export function formaterTrajetsRecherches(bilans: BilanTrajetsRecherche[]): string[] {
  if (!bilans.length) return ['Trajets : aucune recherche n’a de point de départ (« depart » dans recherches.yaml)'];
  return [
    `Trajets (${bilans[0].fournisseur}) :`,
    ...bilans.map((b) => `  ${b.recherche}, depuis ${b.depart ?? '?'} : ${formaterTrajets(b)}`),
  ];
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
  for (const rech of r.recherches) {
    lignes.push(
      '',
      `${rech.recherche} — depuis ${rech.depart ?? '?'} (${rech.fournisseur}) : ${formaterTrajets(rech)}`,
      ...rech.offres.map((o) => `  ${duree(o.trajet)} — ${o.titre} — ${o.commune ?? '?'}`),
    );
  }
  if (r.sans_depart.length) lignes.push('', `Sans point de départ : ${r.sans_depart.join(', ')}`);
  return lignes.join('\n');
}
