import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { Depot } from '../db/depot.ts';
import type { ChampsCode } from '../db/schema.ts';
import { joursAvant, purge } from '../purge.ts';

const JOUR = '2026-12-01';

function installation() {
  const dossier = mkdtempSync(join(tmpdir(), 'csp-'));
  const chemins = {
    base: join(dossier, 'csp.sqlite'),
    dossierBrut: join(dossier, 'brut'),
    dossierDiagnostics: join(dossier, 'diagnostics'),
  };
  mkdirSync(chemins.dossierBrut);
  mkdirSync(chemins.dossierDiagnostics);
  const depot = new Depot(chemins.base);
  /** Offre vue pour la dernière fois `vue`, en attente de résumé depuis la même date. */
  const enAttente = (id: string, vue: string, statut: 'active' | 'expiree') => {
    depot.enregistrerOffre({ id_offre: id, url: 'https://x/', titre: id } as ChampsCode, vue);
    if (statut === 'expiree') {
      for (let i = 0; i < 3; i++) depot.noterAbsences([id]);
      depot.expirer();
    }
    const chemin = join(chemins.dossierBrut, `${id}.txt`);
    writeFileSync(chemin, 'texte');
    depot.ajouterAResumer(id, 'nouvelle', chemin, vue);
    return chemin;
  };
  return { chemins, depot, enAttente };
}

describe('csp purge', () => {
  it('calcule la date limite', () => {
    expect(joursAvant('2026-03-01', 30)).toBe('2026-01-30');
  });

  it('retire de la file les offres disparues depuis plus de 30 jours, garde les actives et les récentes', () => {
    const { chemins, depot, enAttente } = installation();
    const vieille = enAttente('vieille', '2026-10-01', 'expiree');
    const recente = enAttente('recente', '2026-11-20', 'expiree');
    const active = enAttente('active', '2026-10-01', 'active');
    depot.fermer();
    const b = purge({ jour: JOUR, ...chemins });
    expect(b).toMatchObject({ file: ['vieille'], orphelins: ['vieille.txt'] });
    expect([existsSync(vieille), existsSync(recente), existsSync(active)]).toEqual([false, true, true]);
    const d = new Depot(chemins.base);
    expect(d.aResumer().map((a) => a.id_offre)).toEqual(['active', 'recente']);
    d.fermer();
  });

  it('supprime les textes orphelins, jamais un fichier inconnu ni un lien symbolique', () => {
    const { chemins, depot } = installation();
    depot.fermer();
    const orphelin = join(chemins.dossierBrut, 'X-1.txt');
    writeFileSync(orphelin, 'texte');
    const inconnu = join(chemins.dossierBrut, 'notes perso.md');
    writeFileSync(inconnu, 'à garder');
    const cible = join(mkdtempSync(join(tmpdir(), 'csp-')), 'precieux.txt');
    writeFileSync(cible, 'à garder');
    symlinkSync(cible, join(chemins.dossierBrut, 'lien.txt'));
    expect(purge({ jour: JOUR, ...chemins }).orphelins).toEqual(['X-1.txt']);
    expect([existsSync(orphelin), existsSync(inconnu), existsSync(cible)]).toEqual([false, true, true]);
  });

  it('supprime les diagnostics de plus de 30 jours', () => {
    const { chemins, depot } = installation();
    depot.fermer();
    for (const jour of ['2026-10-15', '2026-11-25', 'pas-une-date']) mkdirSync(join(chemins.dossierDiagnostics, jour));
    expect(purge({ jour: JOUR, ...chemins }).diagnostics).toEqual(['2026-10-15']);
    expect(existsSync(join(chemins.dossierDiagnostics, '2026-11-25'))).toBe(true);
    expect(existsSync(join(chemins.dossierDiagnostics, 'pas-une-date'))).toBe(true);
  });

  it('--dry-run : liste sans rien supprimer ni modifier la base', () => {
    const { chemins, depot, enAttente } = installation();
    const vieille = enAttente('vieille', '2026-10-01', 'expiree');
    depot.fermer();
    mkdirSync(join(chemins.dossierDiagnostics, '2026-10-15'));
    const b = purge({ jour: JOUR, dryRun: true, ...chemins });
    expect(b).toMatchObject({
      file: ['vieille'],
      orphelins: ['vieille.txt'],
      diagnostics: ['2026-10-15'],
      apercu: true,
    });
    expect(existsSync(vieille)).toBe(true);
    expect(existsSync(join(chemins.dossierDiagnostics, '2026-10-15'))).toBe(true);
    const d = new Depot(chemins.base);
    expect(d.aResumer()).toHaveLength(1);
    d.fermer();
  });
});
