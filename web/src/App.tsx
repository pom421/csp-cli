import { Moon, RefreshCw, Search, SlidersHorizontal, Sun, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { CarteOffre } from '@/components/carte-offre';
import { DetailOffre } from '@/components/detail-offre';
import { PanneauFiltres } from '@/components/panneau-filtres';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { useOffres } from '@/lib/donnees';
import {
  depuisUrl,
  FILTRES_PAR_DEFAUT,
  filtrer,
  nombreFiltres,
  trier,
  versUrl,
  type Filtres,
  type Tri,
} from '@/lib/filtres';
import * as format from '@/lib/format';
import { useTheme } from '@/lib/theme';
import type { DerniereCollecte, ReponseOffres } from '../../src/web/contrat.ts';

const LIBELLES_TRI: Record<Tri, string> = {
  recentes: 'Plus récentes',
  trajet: 'Trajet le plus court',
  remuneration: 'Mieux rémunérées',
  limite: 'Clôture la plus proche',
};

function resumeCollecte(c: DerniereCollecte | null): string {
  if (!c) return 'Aucune collecte enregistrée';
  const quand = format.date(c.debut.slice(0, 10));
  if (c.statut === 'en_cours') return `Collecte en cours (${quand})`;
  if (c.statut === 'echec') return `Dernière collecte en échec (${quand})`;
  const n = c.nb_nouvelles ?? 0;
  const m = c.nb_modifiees ?? 0;
  return `Collecte du ${quand} : ${format.pluriel(n, 'nouvelle')}, ${format.pluriel(m, 'modifiée')}${c.statut === 'incomplete' ? ' (incomplète)' : ''}`;
}

export function App() {
  const [etat, recharger] = useOffres();
  const [theme, basculerTheme] = useTheme();
  const parametres = new URLSearchParams(location.search);
  const [filtres, setFiltres] = useState<Filtres>(() => depuisUrl(parametres));
  const [ouverte, setOuverte] = useState<string | null>(() => parametres.get('offre'));
  const [filtresMobiles, setFiltresMobiles] = useState(false);

  // Filtres et offre ouverte rangés dans l'URL : un lien ou un marque-page rouvre la même vue.
  useEffect(() => {
    const p = versUrl(filtres);
    if (ouverte) p.set('offre', ouverte);
    const requete = p.toString();
    history.replaceState(null, '', requete ? `?${requete}` : location.pathname);
  }, [filtres, ouverte]);

  if (etat.etat === 'chargement') {
    return <p className="p-10 text-center text-muted-foreground">Chargement des offres…</p>;
  }
  if (etat.etat === 'erreur') {
    return (
      <div className="mx-auto max-w-lg space-y-4 p-10 text-center">
        <p className="font-medium">Impossible de lire les offres.</p>
        <p className="text-sm text-muted-foreground">{etat.message}</p>
        <Button onClick={recharger}>
          <RefreshCw /> Réessayer
        </Button>
      </div>
    );
  }
  return (
    <Vue
      donnees={etat.donnees}
      filtres={filtres}
      setFiltres={setFiltres}
      ouverte={ouverte}
      setOuverte={setOuverte}
      filtresMobiles={filtresMobiles}
      setFiltresMobiles={setFiltresMobiles}
      recharger={recharger}
      theme={theme}
      basculerTheme={basculerTheme}
    />
  );
}

interface PropsVue {
  donnees: ReponseOffres;
  filtres: Filtres;
  setFiltres: (f: Filtres) => void;
  ouverte: string | null;
  setOuverte: (id: string | null) => void;
  filtresMobiles: boolean;
  setFiltresMobiles: (v: boolean) => void;
  recharger: () => void;
  theme: 'clair' | 'sombre';
  basculerTheme: () => void;
}

function Vue({
  donnees,
  filtres,
  setFiltres,
  ouverte,
  setOuverte,
  filtresMobiles,
  setFiltresMobiles,
  recharger,
  theme,
  basculerTheme,
}: PropsVue) {
  const { offres, aujourdhui, recherches } = donnees;
  const visibles = useMemo(
    () => trier(filtrer(offres, filtres, aujourdhui), filtres.tri, filtres.recherche),
    [offres, filtres, aujourdhui],
  );
  const departements = useMemo(
    () => [...new Set(offres.map((o) => o.departement).filter((d): d is string => d !== null))].sort(),
    [offres],
  );
  const offreOuverte = offres.find((o) => o.id_offre === ouverte) ?? null;
  const nb = nombreFiltres(filtres);
  const panneau = (
    <PanneauFiltres filtres={filtres} onChange={setFiltres} recherches={recherches} departements={departements} />
  );

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3 sm:px-6">
          <div className="mr-auto min-w-0">
            <h1 className="text-lg font-semibold tracking-tight">
              Offres{' '}
              <span className="hidden font-normal text-muted-foreground sm:inline">· Choisir le service public</span>
            </h1>
            <p className="truncate text-xs text-muted-foreground">{resumeCollecte(donnees.derniere_collecte)}</p>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" onClick={recharger} title="Relire la base">
              <RefreshCw />
              <span className="sr-only">Relire la base</span>
            </Button>
            <Button variant="ghost" size="icon" onClick={basculerTheme} title="Thème clair ou sombre">
              {theme === 'sombre' ? <Sun /> : <Moon />}
              <span className="sr-only">Changer de thème</span>
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl gap-8 px-4 py-6 sm:px-6 lg:grid-cols-[17rem_1fr]">
        <aside className="hidden lg:block">
          <div className="sticky top-24 max-h-[calc(100vh-7rem)] overflow-y-auto pr-2 pb-6">{panneau}</div>
        </aside>

        <main className="min-w-0 space-y-5">
          {donnees.avertissement && (
            <p className="rounded-lg border border-alerte/40 bg-alerte/10 px-4 py-2.5 text-sm">
              {donnees.avertissement} — les trajets ne sont pas affichés.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <div className="relative min-w-60 flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                value={filtres.texte}
                onChange={(e) => setFiltres({ ...filtres, texte: e.target.value })}
                placeholder="Titre, employeur, compétence, commune…"
                className="h-10 bg-card pl-9"
                aria-label="Rechercher"
              />
            </div>
            <Button variant="outline" className="h-10 lg:hidden" onClick={() => setFiltresMobiles(true)}>
              <SlidersHorizontal /> Filtres
              {nb > 0 && <Badge className="ml-0.5 rounded-full px-1.5">{nb}</Badge>}
            </Button>
            <Select value={filtres.tri} onValueChange={(v) => setFiltres({ ...filtres, tri: v as Tri })}>
              <SelectTrigger className="h-10 w-auto min-w-52 bg-card" aria-label="Trier">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(LIBELLES_TRI) as Tri[]).map((t) => (
                  <SelectItem key={t} value={t}>
                    {LIBELLES_TRI[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{format.pluriel(visibles.length, 'offre')}</span>
            {visibles.length !== offres.length && ` sur ${offres.length}`}
          </p>

          {visibles.length > 0 ? (
            <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">
              {visibles.map((o) => (
                <CarteOffre
                  key={o.id_offre}
                  offre={o}
                  aujourdhui={aujourdhui}
                  recherche={filtres.recherche}
                  onOuvrir={() => setOuverte(o.id_offre)}
                />
              ))}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed px-6 py-16 text-center">
              <p className="font-medium">Aucune offre ne correspond.</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {offres.length ? 'Élargir les filtres ou la recherche.' : 'La base est vide : lancer csp collecte.'}
              </p>
              {(nb > 0 || filtres.texte) && (
                <Button
                  variant="outline"
                  className="mt-4"
                  onClick={() => setFiltres({ ...FILTRES_PAR_DEFAUT, tri: filtres.tri })}
                >
                  <X /> Effacer les filtres
                </Button>
              )}
            </div>
          )}
        </main>
      </div>

      <Sheet open={filtresMobiles} onOpenChange={setFiltresMobiles}>
        <SheetContent side="left" className="p-5 pt-12" aria-describedby={undefined}>
          <SheetTitle className="sr-only">Filtres</SheetTitle>
          {panneau}
        </SheetContent>
      </Sheet>

      <Sheet open={offreOuverte !== null} onOpenChange={(o) => !o && setOuverte(null)}>
        {offreOuverte && <DetailOffre offre={offreOuverte} aujourdhui={aujourdhui} recherches={recherches} />}
      </Sheet>
    </div>
  );
}
