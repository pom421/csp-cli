// Diagnostic : dossier local et droits, .env, recherches, Node, accès au site et aux API.
import { chemins, heureDepart, lireRecherches } from './config.ts';
import { obtenir } from './http.ts';
import { droits, droitsTropOuverts } from './securite/fichiers.ts';
import { origine } from './securite/urls.ts';

type Statut = 'ok' | 'warn' | 'fail';
const ICONE: Record<Statut, string> = { ok: '✔', warn: '⚠', fail: '✘' };

/** Règles du robots.txt relevées le 19/10/2026 (docs/reconnaissance.md) : tout écart est signalé. */
export const ROBOTS_ATTENDU = [
  'allow: /wp-admin/admin-ajax.php',
  'disallow: /wp-admin/',
  'disallow: /wp-content/uploads/pdf-offers/',
];

export function reglesRobots(texte: string): string[] {
  return texte
    .split('\n')
    .map((l) => l.replace(/#.*/, '').trim())
    .filter((l) => /^(allow|disallow)\s*:/i.test(l))
    .map((l) => {
      const [cle, ...reste] = l.split(':');
      return `${cle.trim().toLowerCase()}: ${reste.join(':').trim()}`;
    })
    .sort();
}

export async function doctor(): Promise<number> {
  const c = chemins();
  let echecs = 0;
  const verifier = async (libelle: string, fn: () => Promise<[Statut, string]> | [Statut, string]) => {
    let statut: Statut;
    let detail: string;
    try {
      [statut, detail] = await fn();
    } catch (e) {
      [statut, detail] = ['fail', (e as Error).message.split('\n').join('\n    ')];
    }
    if (statut === 'fail') echecs++;
    console.log(`${ICONE[statut]} ${libelle}${detail ? ` — ${detail}` : ''}`);
    return statut !== 'fail';
  };

  await verifier('Node', async () => {
    await import('node:sqlite');
    return ['ok', `${process.version}, node:sqlite disponible`];
  });

  const dossier = await verifier('Dossier local', () => {
    const ouverts = droitsTropOuverts(c.home);
    if (ouverts === undefined) return ['fail', `absent : mkdir -m 700 -p ${c.home}`];
    return ouverts ? ['fail', `droits ${droits(c.home)} : chmod 700 ${c.home}`] : ['ok', `${c.home}, droits 700`];
  });

  if (dossier) {
    await verifier('.env', () => {
      const ouverts = droitsTropOuverts(c.env);
      if (ouverts === undefined) return ['warn', `absent : cp .env.example ${c.env} && chmod 600 ${c.env}`];
      if (ouverts) return ['fail', `droits ${droits(c.env)} : chmod 600 ${c.env}`];
      heureDepart();
      return process.env.CSP_ORIGINE_TRAJET
        ? ['ok', 'droits 600, adresse de départ définie']
        : ['warn', 'CSP_ORIGINE_TRAJET vide : pas de calcul de trajet'];
    });

    await verifier('Recherches', () => {
      const ouverts = droitsTropOuverts(c.recherches);
      const noms = lireRecherches(c.recherches).map((r) => r.nom);
      return ouverts
        ? ['warn', `droits ${droits(c.recherches)} : chmod 600 ${c.recherches}`]
        : ['ok', `${noms.length} : ${noms.join(', ')}`];
    });

    for (const chemin of [c.base, c.brut, c.diagnostics]) {
      if (droitsTropOuverts(chemin)) {
        await verifier(chemin, () => ['fail', `droits ${droits(chemin)} trop ouverts`]);
      }
    }
  }

  await verifier('Site Choisir le service public', async () => {
    const r = await obtenir(new URL('/robots.txt', origine('site')), 'text/plain');
    if (r.statut !== 200) return ['fail', `robots.txt : HTTP ${r.statut}`];
    const regles = reglesRobots(r.texte);
    const attendu = [...ROBOTS_ATTENDU].sort();
    return JSON.stringify(regles) === JSON.stringify(attendu)
      ? ['ok', 'joignable, robots.txt inchangé']
      : ['warn', `robots.txt modifié, relire CONFORMITE.md :\n    ${regles.join('\n    ')}`];
  });

  for (const [libelle, service] of [
    ['Géocodage (Géoplateforme IGN)', 'geocodage'],
    ['Trajets (Transitous)', 'trajets'],
  ] as const) {
    await verifier(libelle, async () => {
      const r = await obtenir(origine(service) + '/', '*/*');
      return ['ok', `joignable (HTTP ${r.statut})`];
    });
  }

  console.log(`\nDossier local : ${c.home}`);
  console.log(echecs ? `${echecs} problème(s) à corriger.` : 'Tout est prêt.');
  return echecs ? 1 : 0;
}
