import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { lireRecherches } from '../config.ts';
import { reglesRobots, ROBOTS_ATTENDU } from '../doctor.ts';
import { ROBOTS } from './faux-site.ts';

const fichier = (contenu: string) => {
  const f = join(mkdtempSync(join(tmpdir(), 'csp-')), 'recherches.yaml');
  writeFileSync(f, contenu);
  return f;
};

describe('recherches.yaml', () => {
  it("valide l'exemple versionné", () => {
    const [r] = lireRecherches(new URL('../../config/recherches.example.yaml', import.meta.url).pathname);
    expect(r).toMatchObject({ nom: 'numerique-orleans', categories: ['A'], teletravail: true });
  });

  it.each([
    ['nom: x', 'recherches'],
    ['recherches: []', 'recherches'],
    ['recherches:\n  - nom: Avec Espaces', 'recherches.0.nom'],
    ['recherches:\n  - nom: a\n    categories: [D]', 'recherches.0.categories.0'],
    ['recherches:\n  - nom: a\n    localisation: { rayon_km: 25 }', 'commune et rayon_km'],
    ['recherches:\n  - nom: a\n    localisation: { departements: ["99"] }', 'recherches.0.localisation.departements.0'],
    ['recherches:\n  - nom: a\n    localisation: { regions: [Atlantide] }', 'recherches.0.localisation.regions.0'],
    ['recherches:\n  - nom: a\n    champ_inconnu: 1', 'recherches.0'],
    ['recherches:\n  - nom: a\n  - nom: a', 'même nom'],
    ['recherches: [', 'YAML invalide'],
  ])('refuse %j', (yaml, motif) => {
    expect(() => lireRecherches(fichier(yaml))).toThrow(motif);
  });

  it('explique comment créer le fichier absent', () => {
    expect(() => lireRecherches('/nulle/part/recherches.yaml')).toThrow('cp config/recherches.example.yaml');
  });
});

describe('robots.txt', () => {
  it('reconnaît les règles relevées en phase 0', () => {
    expect(reglesRobots(ROBOTS)).toEqual([...ROBOTS_ATTENDU].sort());
  });

  it('détecte une règle ajoutée', () => {
    expect(reglesRobots(`${ROBOTS}\nDisallow: /offre-emploi/`)).not.toEqual([...ROBOTS_ATTENDU].sort());
  });
});
