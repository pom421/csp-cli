import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { collecte, filtrerDetail, formaterBilan, periodeCollecte, verifierResultats } from '../collecte.ts';
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
/** Jour fixe : les cartes des fixtures sont datées d'octobre 2026 (premier import : 30 jours). */
const AUJOURDHUI = () => new Date('2026-10-21T06:00:00+02:00');
const apercu = (o: Omit<Parameters<typeof collecte>[0], 'dryRun'>) =>
  collecte({ dryRun: true, maintenant: AUJOURDHUI, ...o });

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
    // Fixtures relevées sur plusieurs mois : premier import sur un an pour les lire en entier.
    const recherches = [rech('a', { categories: ['A'], premier_import_jours: 365 })];
    const b = await apercu({ source: s, base: base(), recherches });
    expect(demandees).toEqual(['/nos-offres/filtres/categorie/1805/', '/nos-offres/filtres/categorie/1805/page/2/']);
    expect(b.recherches).toEqual([
      {
        nom: 'a',
        pages: 2,
        total: 53325,
        ecartees: 0,
        ecartees_domaine: 0,
        fenetre: null,
        depuis: '2025-10-21',
        tronquee: false,
      },
    ]);
    expect(b.cartes).toHaveLength(40);
    expect(b.nouvelles).toHaveLength(40);
    // Stratégie 2 : seules les publications récentes sont listées, aucune absence n'est comptée.
    expect(b.absentes).toBeNull();
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
    const b = await apercu({ source: s, base: base(), recherches: [rech('a', { versants: ['FPH'] })] });
    const attendues = toutes.filter((c) => c.versant === 'FPH' || c.versant === null);
    expect(b.cartes.map((c) => c.id_offre)).toEqual(attendues.map((c) => c.id_offre).sort());
    expect(b.recherches[0].ecartees).toBe(toutes.length - attendues.length);
  });

  it('compare à la base : nouvelles, connues, réapparues ; absences non comptées', async () => {
    const chemin = base();
    const [c1, c2] = lirePageListe(fixture('liste-page1')).cartes;
    enregistrer(chemin, [
      [c1.id_offre, 'active'],
      [c2.id_offre, 'expiree'],
      ['DISPARUE-1', 'active'],
    ]);
    const { s } = source({ '/nos-offres/': SANS_SUIVANTE(fixture('liste-page1')) });
    const b = await apercu({ source: s, base: chemin, recherches: [rech('a')] });
    expect(b.connues).toEqual([c1.id_offre]);
    expect(b.reapparues).toEqual([c2.id_offre]);
    expect(b.nouvelles).toHaveLength(18);
    expect(b.absentes).toBeNull();
    expect(formaterBilan(b)).toContain('absentes : non comptées (publications récentes seulement');
  });

  it('ne compte aucune absence quand une recherche atteint le plafond de 200 pages', async () => {
    const page = pageMinimale('X-1', true);
    const s: SourcePages = { html: async () => page };
    const b = await apercu({ source: s, base: base(), recherches: [rech('large')] });
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
    await apercu({ source: s, base: chemin, recherches: [rech('a')] });
    expect(existsSync(chemin)).toBe(false);
  });

  it('n’envoie jamais les mots-clés au site et ne les applique pas en aperçu (texte non lu)', async () => {
    const { s, demandees } = source({ '/nos-offres/': pageMinimale('A-1', false) });
    const b = await apercu({ source: s, base: base(), recherches: [rech('a', { mots_cles: ['react'] })] });
    expect(demandees).toEqual(['/nos-offres/']);
    expect(b.cartes.map((c) => c.id_offre)).toEqual(['A-1']);
  });

  it('écarte sur la carte les domaines non retenus, sans toucher aux cartes sans domaine', async () => {
    const page = SANS_SUIVANTE(fixture('liste-page1'));
    const toutes = lirePageListe(page).cartes;
    const { s } = source({ '/nos-offres/': page });
    const b = await apercu({ source: s, base: base(), recherches: [rech('a', { domaines: ['numerique'] })] });
    const attendues = toutes.filter((c) => c.domaine === null || c.domaine === 'Numérique');
    expect(b.cartes.map((c) => c.id_offre)).toEqual(attendues.map((c) => c.id_offre).sort());
    expect(b.recherches[0].ecartees_domaine).toBe(toutes.length - attendues.length);
    expect(formaterBilan(b)).toContain(`${toutes.length - attendues.length} hors domaines`);
  });

  it('s’arrête à la première carte publiée avant la période et l’ignore', async () => {
    const vieille = pageMinimale('V-1', true).replace('1er octobre 2026', '3 septembre 2026');
    const { s, demandees } = source({ '/nos-offres/': vieille });
    const b = await apercu({ source: s, base: base(), recherches: [rech('a')] });
    expect(demandees).toEqual(['/nos-offres/']);
    expect(b.cartes).toEqual([]);
  });

  it('refuse une recherche inconnue', async () => {
    await expect(apercu({ recherche: 'zzz', recherches: [rech('a')] })).rejects.toThrow('inconnue');
  });
});

describe('collecte (écriture)', () => {
  const A = '2026-2445380';
  const B = 'O045261014001282';
  const urlDetail = (id: string) => `/offre-emploi/poste-reference-${id}/`;
  /** Même liste quelle que soit l'URL de recherche (mots-clés, filtres). */
  const sansFiltres = (s: SourcePages): SourcePages => ({
    html: (url, etape) => s.html(new URL(url.href.replace(/filtres\/.*$/, '')), etape),
  });

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
    let decalage = 0;
    return {
      base: join(dossier, 'csp.sqlite'),
      dossierBrut: join(dossier, 'brut'),
      dossierDiagnostics: join(dossier, 'diagnostics'),
      lendemain: () => decalage++,
      avancer: (jours: number) => (decalage += jours),
      maintenant: () => new Date(Date.parse('2026-10-19T06:00:00+02:00') + decalage * 86_400_000),
    };
  }

  const commune = (latitude: number, longitude: number, nom: string): Candidat[] => [
    { latitude, longitude, type: 'municipality', score: 0.95, departement: '45', commune: nom, nom },
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

  /** La liste du faux site est la même quels que soient les filtres (fenêtre de date comprise). */
  const lancer = (ctx: ReturnType<typeof contexte>, s: SourcePages, r: Partial<Parameters<typeof collecte>[0]> = {}) =>
    collecte({
      dryRun: false,
      recherches: [rech('essai')],
      geocodage,
      ...ctx,
      ...r,
      source: sansFiltres(r.source ?? s),
    });

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

  it('lit la veille avec le filtre 48 h du site, puis 7 ou 14 jours après une interruption', async () => {
    const ctx = contexte();
    const { s } = site([A]);
    const demandees: string[] = [];
    const filtres: SourcePages = {
      html: (url, etape) => {
        demandees.push(url.pathname);
        return sansFiltres(s).html(url, etape);
      },
    };
    await collecte({ dryRun: false, recherches: [rech('essai')], geocodage, ...ctx, source: filtres });
    ctx.lendemain();
    await collecte({ dryRun: false, recherches: [rech('essai')], geocodage, ...ctx, source: filtres });
    ctx.avancer(5);
    await collecte({ dryRun: false, recherches: [rech('essai')], geocodage, ...ctx, source: filtres });
    expect(demandees.filter((p) => p.startsWith('/nos-offres/'))).toEqual([
      '/nos-offres/',
      '/nos-offres/filtres/date-de-publication/dernieres_48_heures/',
      '/nos-offres/filtres/date-de-publication/7_derniers_jours/',
    ]);
  });

  it('revérifie par roulement les offres qui ne sont plus listées ; une page disparue les expire', async () => {
    const ctx = contexte();
    await lancer(ctx, site([A, B]).s);
    ctx.avancer(8);
    // Plus aucune publication récente ; A a été retirée du site, B est inchangée.
    const pages: Record<string, string> = {
      '/nos-offres/': fixture('liste-vide'),
      [urlDetail(B)]: fixture(`detail-${B}`),
    };
    const retiree: SourcePages = {
      html: (url, etape) =>
        url.pathname === urlDetail(A)
          ? Promise.reject(new PageAbsenteError('HTTP 404'))
          : source(pages).s.html(url, etape),
    };
    // 2 offres actives : 1 relue par jour (1/7, au moins 1), la plus ancienne d'abord (A, par identifiant).
    const j1 = await lancer(ctx, retiree);
    expect(j1.ecriture).toMatchObject({ reverifiees: 1, retirees: [A] });
    ctx.lendemain();
    const j2 = await lancer(ctx, retiree);
    expect(j2.ecriture).toMatchObject({ reverifiees: 1, retirees: [], inchangees: 1 });
    const d = new Depot(ctx.base);
    expect(d.obtenirOffre(A)!.statut).toBe('expiree');
    expect(d.obtenirOffre(B)).toMatchObject({ statut: 'active', date_derniere_vue: '2026-10-28' });
    d.fermer();
    expect(formaterBilan(j1)).toContain('Revérifiées : 1, dont 1 retirée(s) du site');
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
    // Au-delà de 14 jours sans collecte, la liste est lue sans filtre de date : le garde-fou s'applique.
    ctx.avancer(20);
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
  it('localise les offres et calcule les trajets depuis le point de départ de chaque recherche', async () => {
    const ctx = contexte();
    const appels: string[] = [];
    const fournisseurTrajet: FournisseurTrajet = {
      nom: 'faux',
      calculer: async (_depart, arrivee) => {
        appels.push(`${arrivee.latitude}`);
        return { duree_min: 25, nb_correspondances: 0 };
      },
    };
    const recherches = [rech('essai', { depart: '47.85, 1.92' }), rech('sans-depart')];
    const b = await lancer(ctx, sansFiltres(site([A, B]).s), { fournisseurTrajet, recherches });
    expect(b.geo).toMatchObject({ non_localisees: 0, panne: null });
    expect(b.trajets).toEqual([
      expect.objectContaining({
        recherche: 'essai',
        depart: '47.85, 1.92',
        calcules: 2,
        non_localisees: 0,
        panne: null,
      }),
    ]);
    expect(appels.sort()).toEqual(['43.7', '47.9029']);
    const d = new Depot(ctx.base);
    expect(d.obtenirOffre(B)).toMatchObject({ latitude: 47.9029, longitude: 1.9093, precision_geo: 'commune' });
    d.fermer();
    expect(formaterBilan(b)).toContain('essai, depuis 47.85, 1.92 : 2 calculé(s)');
  });

  it('mots-clés : ne garde que les offres qui en contiennent un en mots entiers, mémorise et ne rouvre pas les autres', async () => {
    const ctx = contexte();
    // B (« développement culturel ») contient « culturel » ; A (recrutement, rectorat de Nice) ne le contient pas.
    const recherches = [rech('essai', { mots_cles: ['culturel', 'react'] })];
    const b = await lancer(ctx, site([A, B]).s, { recherches });
    expect(b.ecriture).toMatchObject({
      nouvelles: [B],
      ecartees: { mots_cles: [A], experience: [] },
      mots: { [B]: ['culturel'] },
      a_resumer: 1,
    });
    expect(formaterBilan(b)).toContain('écartées (aucun mot-clé) : 1');
    expect(formaterBilan(b)).toContain('mots-clés : culturel');
    // Texte gardé (coordonnées retirées) pour rejouer le filtre si les mots changent.
    const texte = join(ctx.dossierBrut, 'ecartees', `${A}.txt`);
    expect(statSync(texte).mode & 0o777).toBe(0o600);
    expect(readFileSync(texte, 'utf8')).not.toMatch(/@/);
    ctx.lendemain();
    const { s, demandees } = site([A, B]);
    const lendemain = await lancer(ctx, s, { recherches });
    expect(lendemain.ecriture).toMatchObject({ deja_ecartees: 1, inchangees: 1 });
    expect(demandees).not.toContain(urlDetail(A));
    const partiel = await lancer(contexte(), site([B]).s, { recherches: [rech('essai', { mots_cles: ['cultur'] })] });
    expect(partiel.ecriture).toMatchObject({ nouvelles: [], ecartees: { mots_cles: [B] } });
  });

  it('écarte l’expérience exclue, garde l’expérience non renseignée', async () => {
    const ctx = contexte();
    const DEBUTANT = 'DEF_30-00069655';
    const recherches = [rech('essai', { experiences_exclues: ['debutant'] })];
    const b = await lancer(ctx, site([A, DEBUTANT]).s, { recherches });
    expect(b.ecriture).toMatchObject({ nouvelles: [A], ecartees: { experience: [DEBUTANT], mots_cles: [] } });
  });

  it('les mots-clés ne filtrent que leur recherche : une offre gardée par une autre recherche est enregistrée', async () => {
    const ctx = contexte();
    const recherches = [rech('stricte', { mots_cles: ['react'] }), rech('large')];
    const b = await lancer(ctx, site([A]).s, { recherches });
    expect(b.ecriture).toMatchObject({ nouvelles: [A] });
    const d = new Depot(ctx.base);
    expect(d.recherchesDe(A)).toEqual(['large']);
    d.fermer();
  });

  it('point de départ introuvable : collecte réussie, trajets signalés comme non calculés', async () => {
    const ctx = contexte();
    const b = await lancer(ctx, site([B]).s, { recherches: [rech('essai', { depart: 'Nulle part' })] });
    expect(b.ecriture).toMatchObject({ nouvelles: [B] });
    expect(b.trajets).toEqual([
      expect.objectContaining({ depart: null, calcules: 0, panne: expect.stringContaining('introuvable') }),
    ]);
    const d = new Depot(ctx.base);
    expect(d.derniereExecution()).toMatchObject({ statut: 'complete', code_sortie: 0 });
    d.fermer();
  });

  it('géocodeur en panne : offres enregistrées sans coordonnées, collecte réussie', async () => {
    const ctx = contexte();
    const enPanne: SourceGeocodage = {
      nom: 'faux',
      chercher: () => Promise.reject(new IndisponibleError('géocodeur injoignable')),
    };
    const b = await lancer(ctx, site([A, B]).s, { geocodage: enPanne });
    expect(b.ecriture).toMatchObject({ nouvelles: [A, B] });
    expect(b.geo).toMatchObject({ non_localisees: 2, panne: 'géocodeur injoignable' });
    const d = new Depot(ctx.base);
    expect(d.derniereExecution()).toMatchObject({ statut: 'complete', code_sortie: 0 });
    d.fermer();
  });
});

describe('garde-fou des résultats', () => {
  const resultat = (nom: string, total: number, fenetre: string | null = null) => ({
    nom,
    pages: 1,
    total,
    cartes: [],
    ecartees: 0,
    ecartees_domaine: 0,
    fenetre,
    depuis: null,
    tronquee: false,
  });
  it('ne s’alarme qu’à partir de 5 offres actives perdues d’un coup', () => {
    expect(() => verifierResultats([resultat('a', 0)], new Map([['a', 4]]))).not.toThrow();
    expect(() => verifierResultats([resultat('a', 3)], new Map([['a', 50]]))).not.toThrow();
    expect(() => verifierResultats([resultat('a', 0)], new Map([['a', 5]]))).toThrow('0 offre annoncée');
  });

  it('se tait quand le filtre de date du site est appliqué (une journée sans publication est normale)', () => {
    expect(() => verifierResultats([resultat('a', 0, 'dernieres_48_heures')], new Map([['a', 50]]))).not.toThrow();
  });
});

describe('période de collecte', () => {
  const r = rech('a');
  it('premier import : 30 jours, ou premier_import_jours', () => {
    expect(periodeCollecte(null, '2026-10-21', r)).toEqual({ depuis: '2026-09-21' });
    expect(periodeCollecte(null, '2026-10-21', rech('a', { premier_import_jours: 7 }))).toEqual({
      depuis: '2026-10-14',
    });
  });

  it('ensuite : la plus courte fenêtre du site qui couvre depuis la dernière collecte, avec un jour de marge', () => {
    expect(periodeCollecte('2026-10-20', '2026-10-21', r)).toEqual({ fenetre: 'dernieres_48_heures' });
    expect(periodeCollecte('2026-10-19', '2026-10-21', r)).toEqual({ fenetre: '7_derniers_jours' });
    expect(periodeCollecte('2026-10-14', '2026-10-21', r)).toEqual({ fenetre: '14_derniers_jours' });
    expect(periodeCollecte('2026-10-01', '2026-10-21', r)).toEqual({ depuis: '2026-09-29' });
  });
});

describe('filtres [Détail]', () => {
  const recherches = new Map([
    ['ia', rech('ia', { mots_cles: ['ia', 'intelligence artificielle'], experiences_exclues: ['debutant'] })],
    ['tout', rech('tout')],
  ]);
  const detail = (texte_brut: string, experience: 'debutant' | 'confirme' | null = null) => ({
    titre: 'Poste',
    texte_brut,
    experience,
  });
  it('mots entiers, sans casse ni accents ; motif d’écart', () => {
    expect(filtrerDetail(['ia'], recherches, detail('Projet d’IA générative'))).toEqual({
      gardee_par: ['ia'],
      mots: ['ia'],
    });
    expect(filtrerDetail(['ia'], recherches, detail('Via la DSI'))).toEqual({ motif: 'mots_cles' });
    expect(filtrerDetail(['ia'], recherches, detail('IA', 'debutant'))).toEqual({ motif: 'experience' });
    expect(filtrerDetail(['ia', 'tout'], recherches, detail('rien'))).toEqual({ gardee_par: ['tout'], mots: [] });
  });
});
