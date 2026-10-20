import { AlertTriangle, ExternalLink, TrainFront } from 'lucide-react';
import type { ReactNode } from 'react';
import { Indices } from '@/components/indices';
import { Resume } from '@/components/resume';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import * as format from '@/lib/format';
import type { OffreWeb, RechercheWeb } from '../../../src/web/contrat.ts';

function Section({ titre, children }: { titre: string; children: ReactNode }) {
  return (
    <section className="space-y-2.5 px-5">
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{titre}</h3>
      {children}
    </section>
  );
}

/** Lignes « libellé : valeur » ; les valeurs inconnues sont omises. */
function Fiche({ lignes }: { lignes: [string, ReactNode | null | undefined][] }) {
  const connues = lignes.filter(([, v]) => v !== null && v !== undefined && v !== '');
  return (
    <dl className="grid grid-cols-[10.5rem_1fr] gap-x-4 gap-y-2 text-sm">
      {connues.map(([libelle, valeur]) => (
        <div key={libelle} className="contents">
          <dt className="text-muted-foreground">{libelle}</dt>
          <dd>{valeur}</dd>
        </div>
      ))}
    </dl>
  );
}

const ouiNon = (v: boolean | null) => (v === null ? null : v ? 'Oui' : 'Non');

interface Props {
  offre: OffreWeb;
  aujourdhui: string;
  recherches: RechercheWeb[];
}

export function DetailOffre({ offre, aujourdhui, recherches }: Props) {
  const departs = recherches.filter((r) => offre.recherches.includes(r.nom) && r.depart);
  const duree = offre.duree_contrat_mois ? format.pluriel(offre.duree_contrat_mois, 'mois', 'mois') : null;
  return (
    <SheetContent className="gap-5 pb-8">
      <SheetHeader className="gap-3 border-b bg-muted/40">
        <div className="flex flex-wrap gap-1.5 empty:hidden">
          <Indices offre={offre} aujourdhui={aujourdhui} />
        </div>
        <SheetTitle>{offre.titre}</SheetTitle>
        <SheetDescription>{[offre.employeur, format.lieu(offre)].filter(Boolean).join(' · ')}</SheetDescription>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {offre.url && (
            <Button asChild size="sm">
              {/* Lien posé par le code et vérifié par le serveur (origine du site) ; jamais un lien du texte. */}
              <a href={offre.url} target="_blank" rel="noopener noreferrer">
                Voir l’offre sur le site <ExternalLink />
              </a>
            </Button>
          )}
          <span className="text-xs text-muted-foreground">Réf. {offre.id_offre}</span>
        </div>
      </SheetHeader>

      {offre.resume ? (
        <Section titre="En bref">
          <Resume texte={offre.resume} />
        </Section>
      ) : (
        <p className="px-5 text-sm text-muted-foreground italic">Pas encore de résumé (csp resumer).</p>
      )}

      {offre.points_attention.length > 0 && (
        <Section titre="Points d’attention">
          <ul className="space-y-1.5 text-sm">
            {offre.points_attention.map((p) => (
              <li key={p} className="flex gap-2">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-alerte" />
                <span>{p}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {offre.competences.length > 0 && (
        <Section titre="Compétences">
          <div className="flex flex-wrap gap-1.5">
            {offre.competences.map((c) => (
              <Badge key={c} variant="secondary" className="font-normal">
                {c}
              </Badge>
            ))}
          </div>
        </Section>
      )}

      {departs.length > 0 && (
        <Section titre="Trajets en transports en commun">
          <ul className="space-y-1.5 text-sm">
            {departs.map((r) => (
              <li key={r.nom} className="flex items-start gap-2">
                <TrainFront className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span>
                  <span className="font-medium">{format.trajet(offre.trajets[r.nom], true)}</span>
                  <span className="text-muted-foreground"> depuis {r.depart}</span>
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Separator />

      <Section titre="Poste">
        <Fiche
          lignes={[
            ['Contrat', offre.type_contrat && format.LIBELLES_CONTRAT[offre.type_contrat]],
            ['Durée', duree],
            ['Temps de travail', offre.temps_travail === 'partiel' ? 'Partiel' : offre.temps_travail && 'Complet'],
            ['Catégorie', offre.categorie],
            ['Fonction publique', offre.versant && format.LIBELLES_VERSANT[offre.versant]],
            ['Métier', offre.metier],
            ['Domaine', offre.domaine],
            ['Rémunération', format.remuneration(offre)],
            ['Précision', offre.remuneration_texte],
            ['Télétravail', format.teletravail(offre) ?? ouiNon(offre.teletravail_possible)],
            [
              'Management',
              offre.management && offre.taille_equipe
                ? `Oui, ${format.pluriel(offre.taille_equipe, 'personne')}`
                : ouiNon(offre.management),
            ],
            [
              'Expérience',
              offre.experience_annees_min !== null
                ? `${format.pluriel(offre.experience_annees_min, 'an')} minimum`
                : null,
            ],
            ['Diplôme', offre.niveau_diplome],
          ]}
        />
      </Section>

      <Section titre="Dates">
        <Fiche
          lignes={[
            ['Publiée le', format.date(offre.date_publication)],
            ['Candidature jusqu’au', format.date(offre.date_limite_candidature)],
            ['Prise de poste', format.date(offre.date_prise_poste)],
            ['Vue la première fois', format.date(offre.date_premiere_vue)],
            ['Dernière modification', format.date(offre.date_maj_detail)],
            ['Recherches', offre.recherches.join(', ')],
          ]}
        />
      </Section>
    </SheetContent>
  );
}
