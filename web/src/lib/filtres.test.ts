import { describe, expect, it } from 'vite-plus/test';
import type { OffreWeb } from '../../../src/web/contrat.ts';
import { depuisUrl, FILTRES_PAR_DEFAUT, filtrer, trajetDe, trier, versUrl, type Filtres } from './filtres.ts';
import { remuneration, trajet } from './format.ts';

const AUJOURDHUI = '2026-10-20';

function offre(id: string, o: Partial<OffreWeb> = {}): OffreWeb {
  return {
    id_offre: id,
    url: null,
    titre: `Poste ${id}`,
    employeur: 'Préfecture',
    versant: 'FPE',
    categorie: 'A',
    type_contrat: 'titulaire',
    duree_contrat_mois: null,
    temps_travail: 'complet',
    metier: null,
    domaine: null,
    commune: 'Orléans',
    code_postal: '45000',
    departement: '45',
    teletravail_possible: null,
    teletravail_jours_semaine: null,
    remuneration_min: null,
    remuneration_max: null,
    remuneration_texte: null,
    management: null,
    taille_equipe: null,
    experience_annees_min: null,
    niveau_diplome: null,
    competences: [],
    points_attention: [],
    resume: null,
    date_publication: null,
    date_limite_candidature: null,
    date_prise_poste: null,
    date_premiere_vue: AUJOURDHUI,
    date_derniere_vue: AUJOURDHUI,
    date_maj_detail: null,
    statut: 'active',
    republication: false,
    recherches: ['loiret'],
    trajets: {},
    ...o,
  };
}

const ids = (offres: OffreWeb[]) => offres.map((o) => o.id_offre);
const avec = (f: Partial<Filtres>): Filtres => ({ ...FILTRES_PAR_DEFAUT, ...f });

describe('filtres', () => {
  it('par défaut : offres actives seulement', () => {
    const offres = [offre('a'), offre('b', { statut: 'expiree' }), offre('c', { statut: 'cloturee' })];
    expect(ids(filtrer(offres, FILTRES_PAR_DEFAUT, AUJOURDHUI))).toEqual(['a']);
    expect(ids(filtrer(offres, avec({ statuts: [] }), AUJOURDHUI))).toEqual(['a', 'b', 'c']);
  });

  it('texte : tous les mots, sans accents ni casse, dans le titre, le résumé ou les compétences', () => {
    const offres = [
      offre('a', { titre: 'Développeur React' }),
      offre('b', { competences: ['Développement', 'react native'] }),
      offre('c', { titre: 'Chargé de mission' }),
    ];
    expect(ids(filtrer(offres, avec({ texte: 'DEVELOPP react' }), AUJOURDHUI))).toEqual(['a', 'b']);
  });

  it('contrat : « titulaire ou contractuel » répond aux deux', () => {
    const offres = [
      offre('a', { type_contrat: 'titulaire' }),
      offre('b', { type_contrat: 'contractuel' }),
      offre('c', { type_contrat: 'titulaire_ou_contractuel' }),
      offre('d', { type_contrat: null }),
    ];
    expect(ids(filtrer(offres, avec({ contrats: ['contractuel'] }), AUJOURDHUI))).toEqual(['b', 'c']);
  });

  it('période : vues pour la première fois depuis N jours', () => {
    const offres = [
      offre('a'),
      offre('b', { date_premiere_vue: '2026-10-15' }),
      offre('c', { date_premiere_vue: '2026-09-01' }),
    ];
    expect(ids(filtrer(offres, avec({ periode: '1' }), AUJOURDHUI))).toEqual(['a']);
    expect(ids(filtrer(offres, avec({ periode: '7' }), AUJOURDHUI))).toEqual(['a', 'b']);
  });

  it('trajet maximum et rémunération minimale écartent les valeurs inconnues', () => {
    const offres = [
      offre('a', { trajets: { loiret: { duree_min: 40, nb_correspondances: 0 } }, remuneration_max: 45_000 }),
      offre('b', { trajets: { loiret: { duree_min: 90, nb_correspondances: 2 } }, remuneration_min: 30_000 }),
      offre('c', { trajets: { loiret: null } }),
      offre('d'),
    ];
    expect(ids(filtrer(offres, avec({ trajetMax: 60 }), AUJOURDHUI))).toEqual(['a']);
    expect(ids(filtrer(offres, avec({ remunerationMin: 35_000 }), AUJOURDHUI))).toEqual(['a']);
  });

  it('télétravail : case du site ou nombre de jours du résumé ; management oui / non', () => {
    const offres = [
      offre('a', { teletravail_possible: true }),
      offre('b', { teletravail_jours_semaine: 2 }),
      offre('c', { management: true }),
      offre('d', { management: false }),
    ];
    expect(ids(filtrer(offres, avec({ teletravail: true }), AUJOURDHUI))).toEqual(['a', 'b']);
    expect(ids(filtrer(offres, avec({ management: 'oui' }), AUJOURDHUI))).toEqual(['c']);
    expect(ids(filtrer(offres, avec({ management: 'non' }), AUJOURDHUI))).toEqual(['d']);
  });

  it('recherche : limite aux offres de la recherche et choisit son départ pour le trajet', () => {
    const o = offre('a', {
      recherches: ['loiret', 'paris'],
      trajets: { loiret: { duree_min: 50, nb_correspondances: 1 }, paris: { duree_min: 20, nb_correspondances: 0 } },
    });
    expect(trajetDe(o, null)?.duree_min).toBe(20);
    expect(trajetDe(o, 'loiret')?.duree_min).toBe(50);
    expect(trajetDe(o, 'autre')).toBeUndefined();
    expect(ids(filtrer([o, offre('b', { recherches: ['loiret'] })], avec({ recherche: 'paris' }), AUJOURDHUI))).toEqual(
      ['a'],
    );
  });
});

describe('tri', () => {
  const offres = [
    offre('a', { trajets: { loiret: { duree_min: 60, nb_correspondances: 1 } }, date_premiere_vue: '2026-10-18' }),
    offre('b', { remuneration_max: 50_000, date_limite_candidature: '2026-10-25' }),
    offre('c', { trajets: { loiret: { duree_min: 30, nb_correspondances: 0 } }, remuneration_min: 40_000 }),
  ];

  it('les plus récentes d’abord, puis par trajet, rémunération, date limite ; inconnues en fin', () => {
    expect(ids(trier(offres, 'recentes', null))).toEqual(['b', 'c', 'a']);
    expect(ids(trier(offres, 'trajet', null))).toEqual(['c', 'a', 'b']);
    expect(ids(trier(offres, 'remuneration', null))).toEqual(['b', 'c', 'a']);
    expect(ids(trier(offres, 'limite', null))).toEqual(['b', 'c', 'a']);
  });
});

describe('filtres ↔ URL', () => {
  it('aller-retour sans perte, URL vide pour les valeurs par défaut', () => {
    const f = avec({
      texte: 'data',
      recherche: 'loiret',
      statuts: ['active', 'cloturee'],
      categories: ['A', 'A+'],
      trajetMax: 45,
      remunerationMin: 40_000,
      teletravail: true,
      departements: ['45', '2A'],
      tri: 'trajet',
    });
    expect(depuisUrl(versUrl(f))).toEqual(f);
    expect(versUrl(FILTRES_PAR_DEFAUT).toString()).toBe('');
  });

  it('ignore les valeurs inconnues d’une URL modifiée à la main', () => {
    const f = depuisUrl(new URLSearchParams('categories=A,Z&trajet=-3&tri=hasard&departements=45,<script>'));
    expect(f.categories).toEqual(['A']);
    expect(f.trajetMax).toBeNull();
    expect(f.tri).toBe('recentes');
    expect(f.departements).toEqual(['45']);
  });
});

describe('format', () => {
  it('rémunération en k€ et trajet lisible', () => {
    expect(remuneration({ remuneration_min: 38_000, remuneration_max: 45_000 })).toBe('38–45 k€');
    expect(remuneration({ remuneration_min: null, remuneration_max: null })).toBeNull();
    expect(trajet({ duree_min: 80, nb_correspondances: 2 }, true)).toBe('1 h 20 · 2 correspondances');
    expect(trajet(null)).toBe('aucun itinéraire');
  });
});
