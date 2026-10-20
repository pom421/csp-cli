import { useCallback, useEffect, useState } from 'react';
import type { ReponseOffres } from '../../../src/web/contrat.ts';

export type Etat =
  | { etat: 'chargement' }
  | { etat: 'erreur'; message: string }
  | { etat: 'pret'; donnees: ReponseOffres };

/** Offres servies par `csp web` ; `recharger` relit la base (après une collecte, sans recharger la page). */
export function useOffres(): [Etat, () => void] {
  const [etat, setEtat] = useState<Etat>({ etat: 'chargement' });
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controle = new AbortController();
    fetch('/api/offres', { signal: controle.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
        return (await r.json()) as ReponseOffres;
      })
      .then(
        (donnees) => setEtat({ etat: 'pret', donnees }),
        (e: Error) => {
          if (e.name !== 'AbortError') setEtat({ etat: 'erreur', message: e.message });
        },
      );
    return () => controle.abort();
  }, [version]);
  return [etat, useCallback(() => setVersion((v) => v + 1), [])];
}
