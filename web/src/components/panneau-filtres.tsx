import { RotateCcw } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  CATEGORIES,
  CONTRATS,
  FILTRES_PAR_DEFAUT,
  nombreFiltres,
  STATUTS,
  VERSANTS,
  type Filtres,
  type Management,
  type Periode,
} from '@/lib/filtres';
import * as format from '@/lib/format';
import type { RechercheWeb, TempsTravail } from '../../../src/web/contrat.ts';

/** Bornes des curseurs : la valeur extrême veut dire « pas de filtre ». */
const TRAJET = { min: 15, max: 120, pas: 5 };
const REMUNERATION = { min: 0, max: 80_000, pas: 2_000 };
const TOUTES = '__toutes__';

function Groupe({ titre, valeur, children }: { titre: string; valeur?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{titre}</h3>
        {valeur && <span className="text-xs font-medium text-primary">{valeur}</span>}
      </div>
      {children}
    </div>
  );
}

interface Props {
  filtres: Filtres;
  onChange: (f: Filtres) => void;
  recherches: RechercheWeb[];
  departements: string[];
}

export function PanneauFiltres({ filtres: f, onChange, recherches, departements }: Props) {
  const poser = (partiel: Partial<Filtres>) => onChange({ ...f, ...partiel });
  const nb = nombreFiltres(f);
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Filtres</h2>
        <Button
          variant="ghost"
          size="sm"
          disabled={nb === 0}
          onClick={() => onChange({ ...FILTRES_PAR_DEFAUT, texte: f.texte, tri: f.tri })}
        >
          <RotateCcw /> Réinitialiser
        </Button>
      </div>

      {recherches.length > 1 && (
        <Groupe titre="Recherche">
          <Select value={f.recherche ?? TOUTES} onValueChange={(v) => poser({ recherche: v === TOUTES ? null : v })}>
            <SelectTrigger aria-label="Recherche">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={TOUTES}>Toutes les recherches</SelectItem>
              {recherches.map((r) => (
                <SelectItem key={r.nom} value={r.nom}>
                  {r.nom}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Groupe>
      )}

      <Groupe titre="Vues pour la première fois">
        <ToggleGroup
          type="single"
          value={f.periode}
          onValueChange={(v) => poser({ periode: (v || 'tout') as Periode })}
        >
          <ToggleGroupItem value="tout">Toutes</ToggleGroupItem>
          <ToggleGroupItem value="1">Aujourd’hui</ToggleGroupItem>
          <ToggleGroupItem value="7">7 jours</ToggleGroupItem>
          <ToggleGroupItem value="30">30 jours</ToggleGroupItem>
        </ToggleGroup>
      </Groupe>

      <Groupe titre="Trajet maximum" valeur={f.trajetMax === null ? 'sans limite' : format.duree(f.trajetMax)}>
        <Slider
          aria-label="Trajet maximum"
          min={TRAJET.min}
          max={TRAJET.max}
          step={TRAJET.pas}
          value={[f.trajetMax ?? TRAJET.max]}
          onValueChange={([v]) => poser({ trajetMax: v >= TRAJET.max ? null : v })}
        />
        {f.trajetMax !== null && (
          <p className="text-xs text-muted-foreground">Les offres sans trajet calculé sont masquées.</p>
        )}
      </Groupe>

      <Groupe
        titre="Rémunération"
        valeur={
          f.remunerationMin === null
            ? 'toutes'
            : `≥ ${format.remuneration({ remuneration_min: f.remunerationMin, remuneration_max: f.remunerationMin })} brut/an`
        }
      >
        <Slider
          aria-label="Rémunération minimale"
          min={REMUNERATION.min}
          max={REMUNERATION.max}
          step={REMUNERATION.pas}
          value={[f.remunerationMin ?? REMUNERATION.min]}
          onValueChange={([v]) => poser({ remunerationMin: v <= REMUNERATION.min ? null : v })}
        />
        {f.remunerationMin !== null && (
          <p className="text-xs text-muted-foreground">Les offres sans rémunération indiquée sont masquées.</p>
        )}
      </Groupe>

      <div className="space-y-3">
        <Label className="justify-between font-normal">
          Télétravail possible
          <Switch checked={f.teletravail} onCheckedChange={(v) => poser({ teletravail: v })} />
        </Label>
      </div>

      <Groupe titre="Catégorie">
        <ToggleGroup
          type="multiple"
          value={f.categories}
          onValueChange={(v) => poser({ categories: v as Filtres['categories'] })}
        >
          {CATEGORIES.map((c) => (
            <ToggleGroupItem key={c} value={c}>
              {c}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </Groupe>

      <Groupe titre="Fonction publique">
        <ToggleGroup
          type="multiple"
          value={f.versants}
          onValueChange={(v) => poser({ versants: v as Filtres['versants'] })}
        >
          {VERSANTS.map((v) => (
            <ToggleGroupItem key={v} value={v}>
              {format.LIBELLES_VERSANT[v]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </Groupe>

      <Groupe titre="Contrat">
        <ToggleGroup
          type="multiple"
          value={f.contrats}
          onValueChange={(v) => poser({ contrats: v as Filtres['contrats'] })}
        >
          {CONTRATS.map((c) => (
            <ToggleGroupItem key={c} value={c}>
              {format.LIBELLES_CONTRAT[c]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <ToggleGroup
          type="single"
          value={f.temps ?? ''}
          onValueChange={(v) => poser({ temps: (v || null) as TempsTravail | null })}
        >
          <ToggleGroupItem value="complet">Temps complet</ToggleGroupItem>
          <ToggleGroupItem value="partiel">Temps partiel</ToggleGroupItem>
        </ToggleGroup>
      </Groupe>

      <Groupe titre="Management">
        <ToggleGroup
          type="single"
          value={f.management}
          onValueChange={(v) => poser({ management: (v || 'tous') as Management })}
        >
          <ToggleGroupItem value="tous">Indifférent</ToggleGroupItem>
          <ToggleGroupItem value="oui">Avec</ToggleGroupItem>
          <ToggleGroupItem value="non">Sans</ToggleGroupItem>
        </ToggleGroup>
      </Groupe>

      {departements.length > 1 && (
        <Groupe titre="Département">
          <ToggleGroup type="multiple" value={f.departements} onValueChange={(v) => poser({ departements: v })}>
            {departements.map((d) => (
              <ToggleGroupItem key={d} value={d}>
                {d}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Groupe>
      )}

      <Groupe titre="Statut">
        <ToggleGroup
          type="multiple"
          value={f.statuts}
          onValueChange={(v) => poser({ statuts: v as Filtres['statuts'] })}
        >
          {STATUTS.map((s) => (
            <ToggleGroupItem key={s} value={s}>
              {format.LIBELLES_STATUT[s]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </Groupe>
    </div>
  );
}
