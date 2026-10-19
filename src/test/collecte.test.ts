import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { collecte, formaterBilan } from '../collecte.ts';
import type { Recherche } from '../config.ts';
import { Depot } from '../db/depot.ts';
import type { ChampsCode } from '../db/schema.ts';
import { lirePageListe } from '../scraper/liste.ts';
import type { SourcePages } from '../scraper/source.ts';
import { fixture, pageMinimale } from './outils.ts';

const SANS_SUIVANTE = (html: string) => html.replaceAll('fr-pagination__link--next', 'fr-pagination__link--sans-suite');

/** Faux site en mémoire : chemin (sans origine) → HTML ; garde la trace des URL demandées. */
function source(pages: Record<string, string>) {
  const demandees: string[] = [];
  const s: SourcePages = {
    async html(url) {
      demandees.push(url.pathname);
      const html = pages[url.pathname];
      if (html === undefined) throw new Error(`page inattendue : ${url.pathname}`);
      return html;
    },
  };
  return { s, demandees };
}

const base = () => join(mkdtempSync(join(tmpdir(), 'csp-')), 'csp.sqlite');
const rech = (nom: string, r: Partial<Recherche> = {}): Recherche => ({ nom, mots_cles: [], ...r });

function enregistrer(chemin: string, ids: [string, 'active' | 'expiree'][]) {
  const d = new Depot(chemin);
  for (const [id, statut] of ids) {
    const champs = { id_offre: id, url: 'https://choisirleservicepublic.gouv.fr/offre-emploi/x/', titre: 'x' };
    d.enregistrerOffre(champs as ChampsCode, '2026-10-18');
    if (statut === 'expiree') {
      d.noterAbsences([id]);
      d.noterAbsences([id]);
      d.noterAbsences([id]);
      d.expirer();
    }
  }
  d.fermer();
}

describe('collecte --dry-run', () => {
  it('parcourt toutes les pages, construit lui-même les URL et s’arrête sans page suivante', async () => {
    const { s, demandees } = source({
      '/nos-offres/filtres/categorie/1805/': fixture('liste-page1'),
      '/nos-offres/filtres/categorie/1805/page/2/': SANS_SUIVANTE(fixture('liste-mot-cle')),
    });
    const b = await collecte({ dryRun: true, source: s, base: base(), recherches: [rech('a', { categories: ['A'] })] });
    expect(demandees).toEqual(['/nos-offres/filtres/categorie/1805/', '/nos-offres/filtres/categorie/1805/page/2/']);
    expect(b.recherches).toEqual([{ nom: 'a', pages: 2, total: 53325, ecartees: 0, tronquee: false }]);
    expect(b.cartes).toHaveLength(40);
    expect(b.nouvelles).toHaveLength(40);
    expect(b.absentes).toEqual([]);
  });

  it('dédoublonne une offre vue dans deux recherches', async () => {
    const page = SANS_SUIVANTE(fixture('liste-page1'));
    const { s } = source({ '/nos-offres/filtres/categorie/1805/': page, '/nos-offres/filtres/categorie/1806/': page });
    const b = await collecte({
      dryRun: true,
      source: s,
      base: base(),
      recherches: [rech('a', { categories: ['A'] }), rech('b', { categories: ['B'] })],
    });
    expect(b.cartes).toHaveLength(20);
    expect(b.cartes.every((c) => c.recherches.join() === 'a,b')).toBe(true);
  });

  it('filtre localement le versant, sans écarter les libellés inconnus', async () => {
    const page = SANS_SUIVANTE(fixture('liste-page1'));
    const toutes = lirePageListe(page).cartes;
    const { s } = source({ '/nos-offres/': page });
    const b = await collecte({ dryRun: true, source: s, base: base(), recherches: [rech('a', { versants: ['FPH'] })] });
    const attendues = toutes.filter((c) => c.versant === 'FPH' || c.versant === null);
    expect(b.cartes.map((c) => c.id_offre)).toEqual(attendues.map((c) => c.id_offre).sort());
    expect(b.recherches[0].ecartees).toBe(toutes.length - attendues.length);
  });

  it('compare à la base : nouvelles, connues, réapparues, absentes', async () => {
    const chemin = base();
    const [c1, c2] = lirePageListe(fixture('liste-page1')).cartes;
    enregistrer(chemin, [
      [c1.id_offre, 'active'],
      [c2.id_offre, 'expiree'],
      ['DISPARUE-1', 'active'],
    ]);
    const { s } = source({ '/nos-offres/': SANS_SUIVANTE(fixture('liste-page1')) });
    const b = await collecte({ dryRun: true, source: s, base: chemin, recherches: [rech('a')] });
    expect(b.connues).toEqual([c1.id_offre]);
    expect(b.reapparues).toEqual([c2.id_offre]);
    expect(b.nouvelles).toHaveLength(18);
    expect(b.absentes).toEqual(['DISPARUE-1']);
    expect(formaterBilan(b)).toContain('absentes : 1');
  });

  it('ne compte aucune absence quand une recherche atteint le plafond de 200 pages', async () => {
    const page = pageMinimale('X-1', true);
    const s: SourcePages = { html: async () => page };
    const b = await collecte({ dryRun: true, source: s, base: base(), recherches: [rech('large')] });
    expect(b.recherches[0]).toMatchObject({ pages: 200, tronquee: true });
    expect(b.absentes).toBeNull();
    expect(b.partielle).toContain('plafond');
    expect(formaterBilan(b)).toContain('PLAFOND ATTEINT');
  });

  it('ne compte aucune absence quand une seule recherche est lancée', async () => {
    const { s } = source({ '/nos-offres/': SANS_SUIVANTE(fixture('liste-vide')) });
    const b = await collecte({
      dryRun: true,
      recherche: 'b',
      source: s,
      base: base(),
      recherches: [rech('a', { categories: ['A'] }), rech('b')],
    });
    expect(b.recherches.map((r) => r.nom)).toEqual(['b']);
    expect(b.absentes).toBeNull();
  });

  it('ne crée pas la base et n’écrit rien', async () => {
    const chemin = base();
    const { s } = source({ '/nos-offres/': fixture('liste-vide') });
    await collecte({ dryRun: true, source: s, base: chemin, recherches: [rech('a')] });
    expect(existsSync(chemin)).toBe(false);
  });

  it('refuse une recherche inconnue et l’écriture tant que la phase 4 manque', async () => {
    await expect(collecte({ dryRun: true, recherche: 'zzz', recherches: [rech('a')] })).rejects.toThrow('inconnue');
    await expect(collecte({ dryRun: false, recherches: [rech('a')] })).rejects.toThrow('--dry-run');
  });
});
