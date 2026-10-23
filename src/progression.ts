// Suivi de progression des commandes longues (collecte, résumés) : reste estimé d'après la durée moyenne déjà observée.

/** « 12 min », « 1 h 05 » : reste estimé après `faites` étapes sur `total`, commencées à `debut` (ms). */
export function resteEstime(debut: number, faites: number, total: number, maintenant = Date.now()): string {
  const min = Math.round((((maintenant - debut) / faites) * (total - faites)) / 60_000);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`;
}
