// Accès aux pages du site derrière une interface : HTTP aujourd'hui, un navigateur reste branchable
// si le site passe un jour au rendu JavaScript (PLAN §2).
import { CasseError } from '../erreurs.ts';
import { obtenir } from '../http.ts';

/** Page retirée entre la liste et le détail (404, 410) : l'offre est sautée, pas une casse du site. */
export class PageAbsenteError extends Error {}

export interface SourcePages {
  /** HTML d'une page ; `etape` nomme l'opération dans les erreurs et diagnostics. */
  html(url: URL, etape: string): Promise<string>;
}

export const sourceHttp: SourcePages = {
  async html(url, etape) {
    const r = await obtenir(url);
    if (r.statut === 404 || r.statut === 410) throw new PageAbsenteError(`HTTP ${r.statut} sur ${r.url}`);
    // 4xx hors blocage (403/429, déjà traités) : la page attendue n'existe plus, le site a changé.
    if (r.statut !== 200) throw new CasseError(etape, `HTTP ${r.statut} sur ${r.url}`);
    return r.texte;
  },
};
