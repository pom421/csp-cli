import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { collecte, formaterBilan, verifierResultats } from '../collecte.ts';
import type { Recherche } from '../config.ts';
import { Depot } from '../db/depot.ts';
import type { ChampsCode } from '../db/schema.ts';
import { IndisponibleError, type CasseError } from '../erreurs.ts';
import type { Candidat, SourceGeocodage } from '../geo/geocodage.ts';
import type { FournisseurTrajet } from '../geo/trajets.ts';
import { lirePageListe } from '../scraper/liste.ts';
import { PageAbsenteError, type SourcePages } from '../scraper/source.ts';
import { fixture, pageMinimale } from './outils.ts';

const CARTE = /<div class="fr-card fr-card--offer">[\s\S]*?<\/ul><\/div><\/div><\/div>/;
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

  it('refuse une recherche inconnue', async () => {
    await expect(collecte({ dryRun: true, recherche: 'zzz', recherches: [rech('a')] })).rejects.toThrow('inconnue');
  });
});

describe('collecte (écriture)', () => {
  const A = '2026-2445380';
  const B = 'O045261014001282';
  const urlDetail = (id: string) => `/offre-emploi/poste-reference-${id}/`;

  /** Liste d'une page contenant `ids`, détails servis depuis les fixtures (modifiables). */
  function site(ids: string[], details: Record<string, string> = {}) {
    const cartes = ids.map(
      (id) =>
        pageMinimale(id, false).match(/<div class="fr-card fr-card--offer">[\s\S]*?<\/ul><\/div><\/div><\/div>/)![0],
    );
    const liste = pageMinimale('X', false).replace(
      /<div class="fr-card fr-card--offer">[\s\S]*?<\/ul><\/div><\/div><\/div>/,
      cartes.join('\n'),
    );
    const pages: Record<string, string> = { '/nos-offres/': liste };
    for (const id of ids) pages[urlDetail(id)] = details[id] ?? fixture(`detail-${id}`);
    return source(pages);
  }

  function contexte() {
    const dossier = mkdtempSync(join(tmpdir(), 'csp-'));
    let jour = 19;
    return {
      base: join(dossier, 'csp.sqlite'),
      dossierBrut: join(dossier, 'brut'),
      dossierDiagnostics: join(dossier, 'diagnostics'),
      lendemain: () => jour++,
      maintenant: () => new Date(`2026-10-${String(jour).padStart(2, '0')}T06:00:00+02:00`),
    };
  }

  const commune = (latitude: number, longitude: number, nom: string): Candidat[] => [
    { latitude, longitude, type: 'municipality', score: 0.95, departement: '45', commune: nom },
  ];
  const communes: Record<string, Candidat[]> = {
    Orléans: commune(47.9029, 1.9093, 'Orléans'),
    Nice: commune(43.7, 7.27, 'Nice'),
  };
  /** Faux géocodeur : Orléans et Nice (lieux des fixtures B et A ; les cartes de test annoncent toutes le Loiret). */
  const geocodage: SourceGeocodage = {
    nom: 'faux',
    chercher: async (q, mode) => (mode === 'commune' && communes[q]) || [],
  };

  const lancer = (ctx: ReturnType<typeof contexte>, s: SourcePages, r: Partial<Parameters<typeof collecte>[0]> = {}) =>
    collecte({ dryRun: false, source: s, recherches: [rech('essai')], geocodage, origineTrajet: '', ...ctx, ...r });

  it('enregistre les nouvelles offres, écrit les textes bruts en 0600 sans coordonnées, met la file à jour', async () => {
    const ctx = contexte();
    const b = await lancer(ctx, site([A, B]).s);
    expect(b.ecriture).toMatchObject({ nouvelles: [A, B], modifiees: [], inchangees: 0, a_resumer: 2 });
    const d = new Depot(ctx.base);
    expect(d.obtenirOffre(B)).toMatchObject({
      titre: "Chef de service du développement culturel (h/f) - COMMUNE D'ORLEANS",
      categorie: 'A',
      type_contrat: 'titulaire_ou_contractuel',
      management: true,
      teletravail_possible: true,
      metier: 'Chargée / Chargé de production culturelle',
      adresse: 'Orléans',
      departement: '45',
      date_limite_candidature: '2026-11-14',
      date_prise_poste: '2026-12-01',
      date_premiere_vue: '2026-10-19',
      statut: 'active',
    });
    expect(d.recherchesDe(A)).toEqual(['essai']);
    const file = d.aResumer();
    expect(file.map((f) => [f.id_offre, f.raison])).toEqual([
      [A, 'nouvelle'],
      [B, 'nouvelle'],
    ]);
    expect(d.derniereExecution()).toMatchObject({ statut: 'complete', code_sortie: 0, nb_cartes: 2, nb_nouvelles: 2 });
    d.fermer();
    const brut = readFileSync(file[0].chemin_brut, 'utf8');
    expect(statSync(file[0].chemin_brut).mode & 0o777).toBe(0o600);
    expect(brut).toContain('## Vos missions en quelques mots');
    expect(brut).not.toMatch(/@/);
    expect(brut).toContain('[coordonnée retirée]');
  });

  it('une seconde collecte identique ne change rien et ne redemande aucun résumé', async () => {
    const ctx = contexte();
    await lancer(ctx, site([A, B]).s);
    ctx.lendemain();
    const b = await lancer(ctx, site([A, B]).s);
    expect(b.ecriture).toMatchObject({ nouvelles: [], modifiees: [], inchangees: 2, a_resumer: 0 });
    const d = new Depot(ctx.base);
    expect(d.obtenirOffre(A)).toMatchObject({ date_premiere_vue: '2026-10-19', date_derniere_vue: '2026-10-20' });
    d.fermer();
  });

  it('ignore les parties volatiles de la page (offres recommandées, nonces, identifiants générés)', async () => {
    const ctx = contexte();
    await lancer(ctx, site([A]).s);
    ctx.lendemain();
    const volatile = fixture(`detail-${A}`)
      .replace(/fav-[0-9a-f]+/g, 'fav-autre')
      .replace(/accordion-[0-9a-f]+/g, 'accordion-autre')
      .replace('Ajouter aux favoris', 'Ajouter à mes favoris');
    const b = await lancer(ctx, site([A], { [A]: volatile }).s);
    expect(b.ecriture).toMatchObject({ modifiees: [], inchangees: 1 });
  });

  it('détecte une modification du texte et remet l’offre dans la file', async () => {
    const ctx = contexte();
    await lancer(ctx, site([B]).s);
    const d1 = new Depot(ctx.base);
    d1.enregistrerResume(
      B,
      {
        resume: 'r',
        points_attention: [],
        competences: [],
        duree_contrat_mois: null,
        teletravail_jours_semaine: null,
        remuneration_min: null,
        remuneration_max: null,
        remuneration_texte: null,
        taille_equipe: null,
        experience_annees_min: null,
        niveau_diplome: null,
      },
      '2026-10-19',
    );
    d1.fermer();
    ctx.lendemain();
    const modifiee = fixture(`detail-${B}`).replace('Esprit d’équipe', 'Esprit d’équipe et sens du service public');
    const b = await lancer(ctx, site([B], { [B]: modifiee }).s);
    expect(b.ecriture).toMatchObject({ modifiees: [B], a_resumer: 1 });
    const d = new Depot(ctx.base);
    expect(d.aResumer().map((f) => f.raison)).toEqual(['modifiee']);
    expect(d.obtenirOffre(B)!.date_maj_detail).toBe('2026-10-20');
    d.fermer();
  });

  it('expire une offre absente de 3 collectes complètes', async () => {
    const ctx = contexte();
    await lancer(ctx, site([A, B]).s);
    for (const jour of [1, 2, 3]) {
      ctx.lendemain();
      const b = await lancer(ctx, site([A]).s);
      expect(b.ecriture!.expirees).toEqual(jour === 3 ? [B] : []);
    }
  });

  it('ne compte pas d’absence sur une collecte partielle (--recherche)', async () => {
    const ctx = contexte();
    await lancer(ctx, site([A, B]).s);
    for (let i = 0; i < 3; i++) {
      ctx.lendemain();
      await lancer(ctx, site([A]).s, { recherche: 'essai' });
    }
    const d = new Depot(ctx.base);
    expect(d.obtenirOffre(B)).toMatchObject({ statut: 'active', absences_consecutives: 0 });
    expect(d.derniereExecution()!.statut).toBe('incomplete');
    d.fermer();
  });

  it('saute une offre dont la page a été retirée entre la liste et le détail', async () => {
    const ctx = contexte();
    const { s } = site([A, B]);
    const retiree: SourcePages = {
      html: (url, etape) =>
        url.pathname === urlDetail(B) ? Promise.reject(new PageAbsenteError('HTTP 404')) : s.html(url, etape),
    };
    const b = await lancer(ctx, retiree);
    expect(b.ecriture).toMatchObject({ nouvelles: [A], pages_retirees: [B] });
  });

  it('échoue franchement (code 2) si la page détail a changé, et le note dans le journal', async () => {
    const ctx = contexte();
    const cassee = fixture(`detail-${A}`).replaceAll('class="table"', 'class="tableau"');
    await expect(lancer(ctx, site([A], { [A]: cassee }).s)).rejects.toMatchObject({ code: 2, etape: 'lire-detail' });
    const d = new Depot(ctx.base);
    expect(d.derniereExecution()).toMatchObject({ statut: 'echec', code_sortie: 2 });
    expect(d.listerOffres()).toEqual([]);
    d.fermer();
  });

  it('sauvegarde le diagnostic d’une casse : étape, sélecteur, URL et HTML de la page, en accès privé', async () => {
    const ctx = contexte();
    const cassee = fixture(`detail-${A}`).replaceAll('class="table"', 'class="tableau"');
    const erreur = await lancer(ctx, site([A], { [A]: cassee }).s).then(
      () => undefined,
      (e: CasseError) => e,
    );
    const dossier = erreur!.diagnostic!;
    expect(dossier.startsWith(join(ctx.dossierDiagnostics, '2026-10-19'))).toBe(true);
    expect(dossier).toMatch(/\/06-00-00-lire-detail$/);
    expect(statSync(dossier).mode & 0o777).toBe(0o700);
    const diag = JSON.parse(readFileSync(join(dossier, 'diagnostic.json'), 'utf8'));
    expect(diag).toMatchObject({ etape: 'lire-detail', html: 'page.html' });
    expect(diag.message).toContain('tableau des caractéristiques introuvable');
    expect(diag.url).toMatch(new RegExp(`/offre-emploi/poste-reference-${A}/$`));
    expect(readFileSync(join(dossier, 'page.html'), 'utf8')).toBe(cassee);
    expect(statSync(join(dossier, 'page.html')).mode & 0o777).toBe(0o600);
  });

  it('pas de diagnostic pour une panne réseau (code 3)', async () => {
    const ctx = contexte();
    const enPanne: SourcePages = { html: () => Promise.reject(new IndisponibleError('site injoignable')) };
    await expect(lancer(ctx, enPanne)).rejects.toMatchObject({ code: 3 });
    expect(existsSync(ctx.dossierDiagnostics)).toBe(false);
  });

  it('refuse une recherche tombée à zéro qui avait des offres actives, sans rien expirer', async () => {
    const ctx = contexte();
    const ids = [A, B, '2025-2136140', 'DEF_30-00069655', 'MEF_2026-32647'];
    await lancer(ctx, site(ids).s);
    ctx.lendemain();
    const vide = source({ '/nos-offres/': fixture('liste-vide') }).s;
    await expect(lancer(ctx, vide)).rejects.toMatchObject({ code: 2, etape: 'resultat-suspect' });
    const d = new Depot(ctx.base);
    expect(d.listerOffres('active')).toHaveLength(5);
    expect(d.listerOffres().every((o) => o.absences_consecutives === 0)).toBe(true);
    d.fermer();
  });

  it('refuse une collecte où plus de 20 % des pages détail sont introuvables', async () => {
    const ctx = contexte();
    const ids = Array.from({ length: 10 }, (_, i) => `X-${i}`);
    const cartes = ids.map((id) => pageMinimale(id, false).match(CARTE)![0]);
    const liste = pageMinimale('X', false).replace(CARTE, cartes.join('\n'));
    const s: SourcePages = {
      html: (url) =>
        url.pathname === '/nos-offres/' ? Promise.resolve(liste) : Promise.reject(new PageAbsenteError('HTTP 404')),
    };
    await expect(lancer(ctx, s)).rejects.toMatchObject({ code: 2, etape: 'lire-detail' });
  });

  it('repère une offre republiée sous un nouvel identifiant', async () => {
    const ctx = contexte();
    await lancer(ctx, site([A]).s);
    ctx.lendemain();
    const N = '2026-9999999';
    const copie = fixture(`detail-${A}`).replace(/(Référence : <\/span>\s*)2026-2445380/, `$1${N}`);
    // Même jour, les deux en ligne : deux postes distincts, pas une republication.
    const memeJour = await lancer(ctx, site([A, N], { [N]: copie }).s, { base: contexte().base });
    expect(memeJour.ecriture!.republications).toEqual([]);
    // Le lendemain de la première collecte, A a disparu et N apparaît : republication.
    const b = await lancer(ctx, site([N], { [N]: copie }).s);
    expect(b.ecriture!.republications).toEqual([{ id_offre: N, republication_de: A }]);
  });
  it('localise les offres et calcule les trajets depuis l’adresse de départ', async () => {
    const ctx = contexte();
    const appels: string[] = [];
    const fournisseurTrajet: FournisseurTrajet = {
      nom: 'faux',
      calculer: async (_depart, arrivee) => {
        appels.push(`${arrivee.latitude}`);
        return { duree_min: 25, nb_correspondances: 0 };
      },
    };
    const b = await lancer(ctx, site([A, B]).s, { fournisseurTrajet, origineTrajet: '47.85, 1.92' });
    expect(b.geo).toMatchObject({ non_localisees: 0, panne: null, rayons_ignores: [] });
    expect(b.trajets).toMatchObject({ calcules: 2, non_localisees: 0, panne: null });
    expect(appels.sort()).toEqual(['43.7', '47.9029']);
    const d = new Depot(ctx.base);
    expect(d.obtenirOffre(B)).toMatchObject({ latitude: 47.9029, longitude: 1.9093, precision_geo: 'commune' });
    d.fermer();
    expect(formaterBilan(b)).toContain('Trajets (faux) : 2 calculé(s)');
  });

  it('adresse de départ introuvable : collecte réussie, trajets signalés comme non calculés', async () => {
    const ctx = contexte();
    const b = await lancer(ctx, site([B]).s, { origineTrajet: 'adresse de départ' });
    expect(b.ecriture).toMatchObject({ nouvelles: [B] });
    expect(b.trajets).toMatchObject({ calcules: 0, panne: expect.stringContaining('adresse introuvable') });
    const d = new Depot(ctx.base);
    expect(d.derniereExecution()).toMatchObject({ statut: 'complete', code_sortie: 0 });
    d.fermer();
  });

  it('écarte les offres hors du rayon : ni enregistrées, ni résumées', async () => {
    const ctx = contexte();
    const recherches = [rech('essai', { localisation: { commune: 'Orléans', rayon_km: 30 } })];
    const b = await lancer(ctx, site([A, B]).s, { recherches });
    expect(b.ecriture).toMatchObject({ nouvelles: [B], hors_zone: [A], a_resumer: 1 });
    const d = new Depot(ctx.base);
    expect(d.obtenirOffre(A)).toBeUndefined();
    d.fermer();
  });

  it('géocodeur en panne : offres enregistrées sans coordonnées, rayon non appliqué, collecte réussie', async () => {
    const ctx = contexte();
    const enPanne: SourceGeocodage = {
      nom: 'faux',
      chercher: () => Promise.reject(new IndisponibleError('géocodeur injoignable')),
    };
    const recherches = [rech('essai', { localisation: { commune: 'Orléans', rayon_km: 30 } })];
    const b = await lancer(ctx, site([A, B]).s, { recherches, geocodage: enPanne });
    expect(b.ecriture).toMatchObject({ nouvelles: [A, B], hors_zone: [] });
    expect(b.geo).toMatchObject({ non_localisees: 2, panne: 'géocodeur injoignable', rayons_ignores: ['essai'] });
    const d = new Depot(ctx.base);
    expect(d.derniereExecution()).toMatchObject({ statut: 'complete', code_sortie: 0 });
    d.fermer();
  });
});

describe('garde-fou des résultats', () => {
  const resultat = (nom: string, total: number) => ({ nom, pages: 1, total, cartes: [], ecartees: 0, tronquee: false });
  it('ne s’alarme qu’à partir de 5 offres actives perdues d’un coup', () => {
    expect(() => verifierResultats([resultat('a', 0)], new Map([['a', 4]]))).not.toThrow();
    expect(() => verifierResultats([resultat('a', 3)], new Map([['a', 50]]))).not.toThrow();
    expect(() => verifierResultats([resultat('a', 0)], new Map([['a', 5]]))).toThrow('0 offre annoncée');
  });
});
