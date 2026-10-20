// Pastilles d'état d'une offre (nouvelle, modifiée, date limite proche, statut), communes à la carte et au détail.
import { Badge } from '@/components/ui/badge';
import { estModifiee, estNouvelle, limiteProche } from '@/lib/filtres';
import { LIBELLES_STATUT } from '@/lib/format';
import type { OffreWeb } from '../../../src/web/contrat.ts';

export function Indices({ offre, aujourdhui }: { offre: OffreWeb; aujourdhui: string }) {
  return (
    <>
      {offre.statut !== 'active' && <Badge variant="destructive">{LIBELLES_STATUT[offre.statut]}</Badge>}
      {estNouvelle(offre, aujourdhui) && <Badge variant="nouveau">Nouvelle</Badge>}
      {!estNouvelle(offre, aujourdhui) && estModifiee(offre, aujourdhui) && <Badge variant="alerte">Modifiée</Badge>}
      {offre.statut === 'active' && limiteProche(offre, aujourdhui) && <Badge variant="alerte">Clôture proche</Badge>}
      {offre.republication && <Badge variant="outline">Republiée</Badge>}
    </>
  );
}
