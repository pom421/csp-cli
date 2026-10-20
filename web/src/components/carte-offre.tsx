import { Briefcase, CalendarClock, Euro, House, MapPin, TrainFront } from 'lucide-react';
import type { ReactNode } from 'react';
import { Indices } from '@/components/indices';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { limiteProche, trajetDe } from '@/lib/filtres';
import * as format from '@/lib/format';
import { cn } from '@/lib/utils';
import type { OffreWeb } from '../../../src/web/contrat.ts';

function Info({ icone, children, className }: { icone: ReactNode; children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      <span className="text-muted-foreground/70 [&_svg]:size-3.5">{icone}</span>
      {children}
    </span>
  );
}

interface Props {
  offre: OffreWeb;
  aujourdhui: string;
  recherche: string | null;
  onOuvrir: () => void;
}

export function CarteOffre({ offre, aujourdhui, recherche, onOuvrir }: Props) {
  const trajet = trajetDe(offre, recherche);
  const lieu = format.lieu(offre);
  const remuneration = format.remuneration(offre);
  const teletravail = format.teletravail(offre);
  const limite = format.date(offre.date_limite_candidature, true);
  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={onOuvrir}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOuvrir();
        }
      }}
      className={cn(
        'group cursor-pointer gap-3 transition-all outline-none hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md focus-visible:ring-[3px] focus-visible:ring-ring/50',
        offre.statut !== 'active' && 'opacity-70',
      )}
    >
      <CardHeader>
        <div className="flex flex-wrap gap-1.5 empty:hidden">
          <Indices offre={offre} aujourdhui={aujourdhui} />
        </div>
        <CardTitle className="line-clamp-2 text-base group-hover:text-primary">{offre.titre}</CardTitle>
        {offre.employeur && <CardDescription className="line-clamp-1">{offre.employeur}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-1.5">
          {offre.categorie && <Badge variant="secondary">Cat. {offre.categorie}</Badge>}
          {offre.versant && <Badge variant="secondary">{format.LIBELLES_VERSANT[offre.versant]}</Badge>}
          {offre.type_contrat && <Badge variant="outline">{format.LIBELLES_CONTRAT[offre.type_contrat]}</Badge>}
          {offre.temps_travail === 'partiel' && <Badge variant="outline">Temps partiel</Badge>}
        </div>
        <div className="grid gap-1.5 text-sm">
          {lieu && <Info icone={<MapPin />}>{lieu}</Info>}
          <Info icone={<TrainFront />} className={cn(!trajet && 'text-muted-foreground')}>
            {format.trajet(trajet, true)}
          </Info>
          {(remuneration || teletravail) && (
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {remuneration && <Info icone={<Euro />}>{remuneration}</Info>}
              {teletravail && <Info icone={<House />}>{teletravail}</Info>}
            </div>
          )}
          {offre.management && (
            <Info icone={<Briefcase />}>
              Management{offre.taille_equipe ? ` · ${format.pluriel(offre.taille_equipe, 'personne')}` : ''}
            </Info>
          )}
          {limite && (
            <Info
              icone={<CalendarClock />}
              className={cn(limiteProche(offre, aujourdhui) && 'font-medium text-alerte')}
            >
              Candidature jusqu’au {limite}
            </Info>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
