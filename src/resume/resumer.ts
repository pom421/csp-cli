// File « à résumer » : lister, enregistrer un résumé (validé, texte brut purgé), ou tout résumer par un fournisseur.
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { relative, resolve, isAbsolute } from 'node:path';
import { chemins } from '../config.ts';
import type { Depot } from '../db/depot.ts';
import { UserError } from '../erreurs.ts';
import { ErreurResume, ReponseNonJson, type FournisseurResume } from './fournisseurs.ts';
import { validerResume, type Resume } from './schema.ts';

export interface EnAttente {
  id_offre: string;
  raison: 'nouvelle' | 'modifiee';
  chemin_brut: string;
  date: string;
  titre: string;
  url: string;
}

export function listerAResumer(depot: Depot): EnAttente[] {
  return depot.aResumer().map((a) => {
    const o = depot.obtenirOffre(a.id_offre)!;
    return { ...a, titre: o.titre, url: o.url };
  });
}

/** Supprime un texte brut, seulement s'il est bien dans le dossier des textes bruts (chemin lu en base). */
function purgerBrut(chemin: string, dossierBrut: string): void {
  if (!existsSync(chemin)) return;
  const reel = realpathSync(chemin);
  const rel = relative(realpathSync(dossierBrut), reel);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new UserError(`Texte brut hors de ${dossierBrut} : ${chemin}`);
  rmSync(reel);
}

/** Valide un résumé, l'écrit en base, retire l'offre de la file et supprime le texte brut. */
export function enregistrerResume(
  depot: Depot,
  idOffre: string,
  json: unknown,
  { date, dossierBrut = chemins().brut }: { date: string; dossierBrut?: string },
): Resume {
  const attente = depot.aResumer().find((a) => a.id_offre === idOffre);
  if (!attente) throw new UserError(`Aucun résumé attendu pour ${idOffre} (csp a-resumer liste la file).`);
  const v = validerResume(json);
  if (!v.ok) throw new UserError(`Résumé invalide pour ${idOffre} :\n  ${v.erreurs.join('\n  ')}`);
  depot.enregistrerResume(idOffre, v.resume, date);
  // Après l'écriture en base : en cas d'échec de la purge, `csp purge` (phase 7) retrouvera le fichier orphelin.
  purgerBrut(attente.chemin_brut, dossierBrut);
  return v.resume;
}

/** Lit un fichier JSON de résumé (écrit par Claude dans une session, ou à la main). */
export function lireFichierJson(chemin: string): unknown {
  const absolu = resolve(chemin);
  if (!existsSync(absolu)) throw new UserError(`Fichier introuvable : ${chemin}`);
  try {
    return JSON.parse(readFileSync(absolu, 'utf8'));
  } catch (e) {
    throw new UserError(`${chemin} : JSON invalide (${(e as Error).message})`);
  }
}

export interface BilanResumes {
  fournisseur: string;
  resumees: string[];
  echecs: { id_offre: string; raison: string }[];
  restantes: number;
}

type Resultat = { id_offre: string; ok: true } | { id_offre: string; ok: false; raison: string };

/** Demande un résumé au modèle ; une réponse invalide lui est renvoyée une fois, avec les erreurs de validation. */
async function obtenirResume(fournisseur: FournisseurResume, texteBrut: string): Promise<Resume> {
  let erreurs: string[] = [];
  for (const essai of [0, 1]) {
    let json: unknown;
    try {
      json = await fournisseur.proposer(texteBrut, essai ? { erreurs } : undefined);
    } catch (e) {
      if (!(e instanceof ReponseNonJson)) throw e;
      erreurs = [e.message];
      continue;
    }
    const v = validerResume(json);
    if (v.ok) return v.resume;
    erreurs = v.erreurs;
  }
  throw new ErreurResume(`réponse invalide après relance : ${erreurs.join(' ; ')}`);
}

/** Résume une offre de la file. Seul un échec propre à l'offre est rendu comme résultat ; le reste est levé. */
async function resumerUne(
  depot: Depot,
  fournisseur: FournisseurResume,
  attente: { id_offre: string; chemin_brut: string },
  options: { date: string; dossierBrut: string },
): Promise<Resultat> {
  const { id_offre } = attente;
  if (!existsSync(attente.chemin_brut)) {
    return { id_offre, ok: false, raison: 'texte brut introuvable : relancer csp collecte' };
  }
  try {
    const resume = await obtenirResume(fournisseur, readFileSync(attente.chemin_brut, 'utf8'));
    enregistrerResume(depot, id_offre, resume, options);
    return { id_offre, ok: true };
  } catch (e) {
    if (!(e instanceof ErreurResume)) throw e;
    return { id_offre, ok: false, raison: e.message };
  }
}

/** Réducteur : chaque résultat va dans les résumées ou dans les échecs. */
const cumuler = (bilan: BilanResumes, r: Resultat): BilanResumes =>
  r.ok
    ? { ...bilan, resumees: [...bilan.resumees, r.id_offre] }
    : { ...bilan, echecs: [...bilan.echecs, { id_offre: r.id_offre, raison: r.raison }] };

/**
 * Résume la file par le fournisseur configuré, une offre après l'autre. Un échec sur une offre n'arrête pas les
 * autres ; une erreur de configuration ou d'indisponibilité arrête tout.
 */
export async function resumerFile(
  depot: Depot,
  fournisseur: FournisseurResume,
  { date, limite = Infinity, dossierBrut = chemins().brut }: { date: string; limite?: number; dossierBrut?: string },
): Promise<BilanResumes> {
  const resultats: Resultat[] = [];
  // Séquentiel volontairement : débit maîtrisé côté fournisseur, et un arrêt laisse les offres déjà traitées en base.
  for (const attente of depot.aResumer().slice(0, limite)) {
    resultats.push(await resumerUne(depot, fournisseur, attente, { date, dossierBrut }));
  }
  const vide: BilanResumes = {
    fournisseur: `${fournisseur.nom} (${fournisseur.modele})`,
    resumees: [],
    echecs: [],
    restantes: 0,
  };
  return { ...resultats.reduce(cumuler, vide), restantes: depot.aResumer().length };
}
