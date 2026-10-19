// File « à résumer » : lister, enregistrer un résumé (validé, texte brut purgé), ou tout résumer par un fournisseur.
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { relative, resolve, isAbsolute } from 'node:path';
import { chemins } from '../config.ts';
import type { Depot } from '../db/depot.ts';
import { UserError } from '../erreurs.ts';
import { ErreurResume, type FournisseurResume } from './fournisseurs.ts';
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

/** Extrait l'objet JSON d'une réponse (certains modèles l'entourent d'un bloc ```json malgré la consigne). */
function analyserJson(texte: string): unknown {
  const bloc = /```(?:json)?\s*([\s\S]*?)```/.exec(texte);
  return JSON.parse((bloc ? bloc[1] : texte).trim());
}

/**
 * Résume la file par le fournisseur configuré. Une réponse invalide est renvoyée une fois au modèle avec les erreurs ;
 * un échec sur une offre n'arrête pas les autres. Une erreur de configuration ou d'indisponibilité arrête tout.
 */
export async function resumerFile(
  depot: Depot,
  fournisseur: FournisseurResume,
  { date, limite = Infinity, dossierBrut = chemins().brut }: { date: string; limite?: number; dossierBrut?: string },
): Promise<BilanResumes> {
  const file = depot.aResumer();
  const bilan: BilanResumes = {
    fournisseur: `${fournisseur.nom} (${fournisseur.modele})`,
    resumees: [],
    echecs: [],
    restantes: 0,
  };
  for (const attente of file.slice(0, limite)) {
    if (!existsSync(attente.chemin_brut)) {
      bilan.echecs.push({ id_offre: attente.id_offre, raison: 'texte brut introuvable : relancer csp collecte' });
      continue;
    }
    const texteBrut = readFileSync(attente.chemin_brut, 'utf8');
    try {
      let erreurs: string[] = [];
      let resume: Resume | undefined;
      for (let essai = 0; essai < 2 && !resume; essai++) {
        const reponse = await fournisseur.proposer(texteBrut, essai ? { erreurs } : undefined);
        let json: unknown;
        try {
          json = analyserJson(reponse);
        } catch {
          erreurs = ['la réponse n’est pas un objet JSON valide'];
          continue;
        }
        const v = validerResume(json);
        if (v.ok) resume = v.resume;
        else erreurs = v.erreurs;
      }
      if (!resume) throw new ErreurResume(`réponse invalide après relance : ${erreurs.join(' ; ')}`);
      enregistrerResume(depot, attente.id_offre, resume, { date, dossierBrut });
      bilan.resumees.push(attente.id_offre);
    } catch (e) {
      if (!(e instanceof ErreurResume)) throw e;
      bilan.echecs.push({ id_offre: attente.id_offre, raison: e.message });
    }
  }
  bilan.restantes = depot.aResumer().length;
  return bilan;
}
