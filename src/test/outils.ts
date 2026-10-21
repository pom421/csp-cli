// Utilitaires partagés des tests (pas de test ici : importer un fichier *.test.ts rejouerait ses tests).
import { readFileSync } from 'node:fs';

export const fixture = (nom: string) => readFileSync(new URL(`fixtures/${nom}.html`, import.meta.url), 'utf8');

/**
 * Page de liste minimale (structure DSFR du site) : une carte et, au choix, un lien de page suivante. `enLigne` : date
 * de publication telle que l'affiche le site.
 */
export function pageMinimale(reference: string, suivante: boolean, enLigne = '1er octobre 2026'): string {
  return `<!doctype html><html><body>
<div class="fr-col-12 actions"><p role="heading"><span class="number">9999</span> offres d'emploi trouvées</p></div>
<div class="fr-card fr-card--offer"><div class="fr-card__body"><div class="fr-card__content">
<h3 class="fr-card__title"><a href="https://choisirleservicepublic.gouv.fr/offre-emploi/poste-reference-${reference}/">Poste ${reference}</a></h3>
<ul class="fr-card__desc">
<li><span class="sr-only">Localisation : </span>Loiret <strong>(45)</strong></li>
<li><span class="sr-only">Fonction publique : </span>Fonction publique Territoriale</li>
<li><span class="sr-only">Employeur : </span>Commune</li>
<li>En ligne depuis le ${enLigne}</li>
</ul></div></div></div>
${suivante ? '<a class="fr-pagination__link fr-pagination__link--next" href="#">Suivante</a>' : ''}
</body></html>`;
}
