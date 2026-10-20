import { describe, expect, it } from 'vite-plus/test';
import type { Recherche } from '../config.ts';
import { CasseError } from '../erreurs.ts';
import { lireDetail, retirerCoordonnees } from '../scraper/detail.ts';
import { lirePageListe } from '../scraper/liste.ts';
import {
  cleComparaison,
  contientMotExact,
  dateFrancaise,
  dateNumerique,
  empreinte,
  empreinteIdentite,
  normaliserTexte,
} from '../scraper/normalisation.ts';
import { urlRecherche } from '../scraper/url.ts';
import { fixture, pageMinimale } from './outils.ts';

const recherche = (r: Partial<Recherche> = {}): Recherche => ({ nom: 'essai', mots_cles: [], ...r });

describe('URL de recherche', () => {
  const site = 'https://choisirleservicepublic.gouv.fr/nos-offres/';

  it('sans filtre : la liste complète', () => {
    expect(urlRecherche(recherche()).href).toBe(site);
    expect(urlRecherche(recherche(), 3).href).toBe(`${site}page/3/`);
  });

  it('reproduit le format relevé dans le navigateur', () => {
    const r = recherche({
      mots_cles: ['chef de projet', 'numérique'],
      localisation: { departements: ['45', '41'], regions: ['Centre-Val de Loire'] },
      categories: ['A', 'B'],
      type_contrat: ['contractuel'],
      management: true,
      teletravail: true,
      experience: 'confirme',
    });
    expect(urlRecherche(r, 2).href).toBe(
      `${site}filtres/mot-cles/chef%20de%20projet%20num%C3%A9rique/localisation/202-263-262/categorie/1805-1806/` +
        'type/2349-2267/management/1814/teletravail/1814/experience/1834/page/2/',
    );
  });

  it('A+ regroupe ses deux sous-catégories', () => {
    expect(urlRecherche(recherche({ categories: ['A+'] })).pathname).toBe('/nos-offres/filtres/categorie/4327-4328/');
  });

  it('titulaire et contractuel ensemble : aucun filtre de nature', () => {
    expect(urlRecherche(recherche({ type_contrat: ['titulaire', 'contractuel'] })).pathname).toBe('/nos-offres/');
    expect(urlRecherche(recherche({ type_contrat: ['titulaire'] })).pathname).toBe(
      '/nos-offres/filtres/type/2349-4534/',
    );
  });

  it('remplace « / » dans le mot-clé comme le site, et encode le reste', () => {
    expect(urlRecherche(recherche({ mots_cles: ['RH/paie & co'] })).pathname).toBe(
      '/nos-offres/filtres/mot-cles/RH---paie%20%26%20co/',
    );
  });

  it('le point de départ ne va pas dans l’URL (il ne sert qu’aux trajets)', () => {
    expect(urlRecherche(recherche({ depart: "Gare d'Orléans" })).pathname).toBe('/nos-offres/');
  });

  it.each([0, 201, 1.5])('refuse la page %s', (page) => {
    expect(() => urlRecherche(recherche(), page)).toThrow(RangeError);
  });
});

describe('page de liste', () => {
  it('lit les 20 cartes, le total et la page suivante', () => {
    const p = lirePageListe(fixture('liste-page1'));
    expect(p).toMatchObject({ total: 53325, suivante: true });
    expect(p.cartes).toHaveLength(20);
    expect(p.cartes[0]).toEqual({
      id_offre: 'MAE_1aa0659e-d83c-4537-95f4-039f51a6902e',
      url: 'https://choisirleservicepublic.gouv.fr/offre-emploi/redacteur-sante-publique-et-innovations-en-sante-fh-reference-MAE_1aa0659e-d83c-4537-95f4-039f51a6902e/',
      titre: 'Rédacteur "Santé publique et innovations en santé" (F/H)',
      employeur: "Ministère de l'Europe et des Affaires étrangères",
      versant: 'FPE',
      domaine: 'International',
      localisation: 'Paris (75)',
      departement: '75',
      date_publication: '2026-10-19',
      empreinte_carte: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(new Set(p.cartes.map((c) => c.id_offre)).size).toBe(20);
    expect(p.cartes.every((c) => c.date_publication && c.departement && c.employeur)).toBe(true);
  });

  it('lit une recherche par mot-clé', () => {
    const p = lirePageListe(fixture('liste-mot-cle'));
    expect(p.total).toBe(28971);
    expect(p.cartes[0]).toMatchObject({ id_offre: 'O093260911001001', versant: 'FPT', departement: '93' });
  });

  it('lit une page minimale (date « 1er »)', () => {
    expect(lirePageListe(pageMinimale('X-1', false)).cartes[0]).toMatchObject({
      id_offre: 'X-1',
      versant: 'FPT',
      departement: '45',
      date_publication: '2026-10-01',
    });
  });

  it('reconnaît une recherche sans résultat', () => {
    expect(lirePageListe(fixture('liste-vide'))).toEqual({ total: 0, cartes: [], suivante: false });
  });

  it('donne la même empreinte de carte deux fois de suite', () => {
    const a = lirePageListe(fixture('liste-page1')).cartes.map((c) => c.empreinte_carte);
    const b = lirePageListe(fixture('liste-page1')).cartes.map((c) => c.empreinte_carte);
    expect(a).toEqual(b);
  });

  const casse = (html: string) => {
    try {
      lirePageListe(html);
    } catch (e) {
      return e;
    }
    return undefined;
  };

  it('échoue franchement (code 2) si le compteur disparaît', () => {
    const e = casse(fixture('liste-page1').replaceAll('role="heading"', 'role="x"'));
    expect(e).toBeInstanceOf(CasseError);
    expect(e).toMatchObject({ etape: 'lire-compteur', code: 2 });
  });

  it('échoue franchement si les cartes changent de classe', () => {
    const e = casse(fixture('liste-page1').replaceAll('fr-card--offer', 'fr-card--autre'));
    expect(e).toMatchObject({ etape: 'lire-cartes', code: 2 });
  });

  it('échoue franchement si une carte perd sa référence', () => {
    const e = casse(fixture('liste-page1').replace('-reference-MAE_1aa0659e', '-ref-MAE_1aa0659e'));
    expect(e).toMatchObject({ etape: 'lire-cartes', message: expect.stringContaining('carte 0') });
  });

  it('ne garde jamais une URL étrangère trouvée dans une carte', () => {
    const html = fixture('liste-page1').replace(
      'https://choisirleservicepublic.gouv.fr/offre-emploi/redacteur',
      'https://pirate.exemple.com/offre-emploi/redacteur',
    );
    expect(lirePageListe(html).cartes[0].url).toMatch(/^https:\/\/choisirleservicepublic\.gouv\.fr\/offre-emploi\//);
  });
});

describe('mots exacts', () => {
  it.each([
    ['Développeur Frontend JavaScript / REACT F/H', true],
    ['Développeur(se) Full Stack (PHP, Symfony, Java, Python, Node.Js, React)', true],
    ['Chef de la section achats réactifs', false],
    ['Recherche en Reactive Synthesis', false],
    ['adjoint à la cheffe d’unité REACH, CLP', false],
    ['Sens de la réactivité attendu', false],
  ])('« react » dans %j : %s', (texte, attendu) => {
    expect(contientMotExact(texte, 'react')).toBe(attendu);
  });

  it('cherche une expression entière, accents et casse ignorés', () => {
    expect(contientMotExact('Chef de projet numérique (H/F)', 'chef de projet numerique')).toBe(true);
    expect(contientMotExact('Chef de projet informatique', 'chef de projet numérique')).toBe(false);
    expect(contientMotExact('Développeur Node.js', 'node.js')).toBe(true);
    expect(contientMotExact('n’importe quoi', '  ')).toBe(false);
  });
});

describe('normalisation', () => {
  it('réduit les espaces et retire les caractères de contrôle', () => {
    expect(normaliserTexte(' a  b\n\tc\u001b[31m​ ')).toBe('a b c[31m');
  });

  it('compare sans accents, casse ni ponctuation', () => {
    expect(cleComparaison('Chargé(e) de MISSION – Orléans')).toBe('charge e de mission orleans');
  });

  it('empreinte stable, sensible au contenu, distingue null et vide', () => {
    expect(empreinte('a  b', null)).toBe(empreinte('a b', null));
    expect(empreinte('a', null)).not.toBe(empreinte('a', ''));
    expect(empreinteIdentite('Chargé de mission', 'Rectorat', 'Nice')).toBe(
      empreinteIdentite('CHARGE DE MISSION', 'rectorat', 'nice'),
    );
  });

  it.each([
    [['19', 'octobre', '2026'], '2026-10-19'],
    [['1', 'Février', '2027'], '2027-02-01'],
    [['1', 'aout', '2026'], '2026-08-01'],
    [['31', 'novembre', '2026'], null],
    [['3', 'brumaire', '2026'], null],
  ] as const)('date %j → %s', (parties, attendu) => {
    const [jour, mois, annee] = parties;
    expect(dateFrancaise(jour, mois, annee)).toBe(attendu);
  });

  it('lit les dates JJ/MM/AAAA', () => {
    expect(dateNumerique('16/11/2026')).toBe('2026-11-16');
    expect(dateNumerique('30/02/2026')).toBeNull();
    expect(dateNumerique('2026-11-16')).toBeNull();
  });
});

describe('page détail', () => {
  const lire = (id: string, html = fixture(`detail-${id}`)) => lireDetail(html, id);

  it.each([
    [
      '2026-2445380',
      {
        categorie: 'A',
        management: null,
        teletravail_possible: null,
        departement: '06',
        commune: null,
        date_limite_candidature: '2026-11-16',
        metier: 'Chargée / Chargé du recrutement',
      },
    ],
    [
      '2025-2136140',
      {
        code_postal: '45160',
        commune: 'OLIVET',
        management: false,
        teletravail_possible: true,
        date_limite_candidature: null,
      },
    ],
    [
      'DEF_30-00069655',
      { lieu: 'ROUTE DEPT 97 45400 FLEURY LES AUBRAIS', commune: 'FLEURY LES AUBRAIS', date_prise_poste: '2026-07-15' },
    ],
    [
      'MEF_2026-32647',
      {
        employeur: 'Direction générale des Entreprises (DGE)',
        lieu: 'Loiret (45), France',
        date_limite_candidature: '2026-10-30',
      },
    ],
    [
      'O045261014001282',
      { management: true, lieu: 'Orléans', domaine: 'Culture et patrimoine', date_publication: '2026-10-14' },
    ],
  ] as const)('lit les champs structurés de %s', (id, attendu) => {
    const d = lire(id);
    expect(d).toMatchObject({ id_offre: id, type_contrat: 'titulaire_ou_contractuel', ...attendu });
    expect(d.empreinte_detail).toMatch(/^[0-9a-f]{64}$/);
  });

  it('prépare un texte brut lisible, sans e-mail ni téléphone', () => {
    const t = lire('2026-2445380').texte_brut;
    expect(t.split('\n').slice(0, 4)).toEqual([
      '# Chargé(e) de mission recrutement et attractivité',
      'Employeur : Rectorat de Nice',
      "Lieu : Rectorat de l'académie de Nice",
      'Nature de l’emploi : Emploi ouvert aux titulaires et aux contractuels',
    ]);
    expect(t).toContain('## Vos missions en quelques mots');
    expect(t).toContain('## Statut du poste\nVacant à partir du 16/11/2026');
    expect(t).not.toContain('Qui sommes-nous');
    expect(t).not.toMatch(/@|recommandées/);
  });

  it('retire e-mails et numéros, garde dates et références', () => {
    expect(retirerCoordonnees('Écrire à jean.dupont@ac-nice.fr ou au 06 12 34 56 78 / +33 1 23 45 67 89')).toBe(
      'Écrire à [coordonnée retirée] ou au [coordonnée retirée] / [coordonnée retirée]',
    );
    expect(retirerCoordonnees('Vacant au 16/11/2026, réf. O006260612001543')).toBe(
      'Vacant au 16/11/2026, réf. O006260612001543',
    );
  });

  it('échoue franchement si la référence ne correspond pas à l’offre attendue', () => {
    expect(() => lireDetail(fixture('detail-2026-2445380'), 'AUTRE-1')).toThrow(
      /\[lire-detail\] référence « 2026-2445380 »/,
    );
  });

  it.each([
    ['tableau', (h: string) => h.replaceAll('class="table"', 'class="x"'), 'tableau des caractéristiques'],
    ['texte libre', (h: string) => h.replaceAll('col-left rte', 'col-left'), "texte de l'offre"],
    ['titre', (h: string) => h.replace(/<h1[^>]*>[\s\S]*?<\/h1>/, '').replace(/"title"\s*:\s*"[^"]*",/, ''), 'titre'],
  ])('échoue franchement si le %s disparaît', (_nom, casser, motif) => {
    expect(() => lire('2026-2445380', casser(fixture('detail-2026-2445380')))).toThrow(motif);
  });
});
