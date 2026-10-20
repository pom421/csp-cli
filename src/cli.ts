#!/usr/bin/env -S node --use-system-ca --disable-warning=ExperimentalWarning
import { existsSync } from 'node:fs';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { chargerEnv, chemins } from './config.ts';
import type { Depot } from './db/depot.ts';
import { CasseError, codeDeSortie, UserError } from './erreurs.ts';
import { appliquerProxy, utiliserCertificatsSysteme } from './http.ts';

type Valeurs = Record<string, string | boolean | undefined>;

interface Commande {
  /** Syntaxe affichée dans l'aide, après le nom de la commande. */
  syntaxe?: string;
  aide: string;
  options?: ParseArgsConfig['options'];
  /** Arguments positionnels attendus (exactement). */
  positionnels?: number;
  /** Code de sortie de la commande. Les modules sont chargés à la demande : `csp doctor` ne charge pas le AI SDK. */
  executer(valeurs: Valeurs, positionnels: string[]): Promise<number>;
}

const JSON_OPTION = { json: { type: 'boolean' } } as const;
const aujourdhui = async () => (await import('./collecte.ts')).jourParis(new Date());
const afficher = (valeurs: Valeurs, donnee: unknown, texte: () => string) =>
  console.log(valeurs.json ? JSON.stringify(donnee, null, 2) : texte());

/** Ouvre la base (qui doit exister), exécute `fn`, referme. */
async function avecDepot<T>(fn: (d: Depot) => T | Promise<T>): Promise<T> {
  const base = chemins().base;
  if (!existsSync(base)) throw new UserError(`Base absente (${base}) : lancez d'abord csp collecte.`);
  const { Depot } = await import('./db/depot.ts');
  const depot = new Depot(base);
  try {
    return await fn(depot);
  } finally {
    depot.fermer();
  }
}

function entierOptionnel(brut: string | boolean | undefined, nom: string): number {
  if (brut === undefined) return Infinity;
  const n = Number(brut);
  if (!Number.isInteger(n) || n < 0) throw new UserError(`--${nom} attend un entier positif : ${String(brut)}`);
  return n;
}

const COMMANDES: Record<string, Commande> = {
  doctor: {
    aide: 'Vérifie dossier local et droits, .env, recherches, accès au site et aux API',
    executer: async () => (await import('./doctor.ts')).doctor(),
  },
  collecte: {
    syntaxe: '[--dry-run] [--recherche <nom>] [--json]',
    aide:
      'Parcourt les recherches, lit chaque offre, met la base à jour et prépare les textes à résumer ;\n' +
      "--dry-run : listes seules, comparées à la base, rien n'est écrit",
    options: { 'dry-run': { type: 'boolean' }, recherche: { type: 'string' }, ...JSON_OPTION },
    async executer(v) {
      const { collecte, formaterBilan } = await import('./collecte.ts');
      const bilan = await collecte({ dryRun: Boolean(v['dry-run']), recherche: v.recherche as string | undefined });
      afficher(v, bilan, () => formaterBilan(bilan));
      return 0;
    },
  },
  trajets: {
    syntaxe: '[--recalculer] [--json]',
    aide:
      'Localise les offres actives qui ne le sont pas encore, calcule les trajets manquants depuis le point de départ\n' +
      'de chaque recherche (« depart » dans recherches.yaml) ; --recalculer : les recalcule tous',
    options: { recalculer: { type: 'boolean' }, ...JSON_OPTION },
    async executer(v) {
      if (!existsSync(chemins().base))
        throw new UserError(`Base absente (${chemins().base}) : lancez d'abord csp collecte.`);
      const { trajets, formaterResultatTrajets } = await import('./trajets.ts');
      const resultat = await trajets({ jour: await aujourdhui(), recalculer: Boolean(v.recalculer) });
      afficher(v, resultat, () => formaterResultatTrajets(resultat));
      return 0;
    },
  },
  purge: {
    syntaxe: '[--dry-run] [--json]',
    aide:
      'Supprime les textes bruts orphelins ou d’offres disparues depuis 30 jours et les diagnostics de plus de 30 jours ;\n' +
      '--dry-run : liste sans rien supprimer',
    options: { 'dry-run': { type: 'boolean' }, ...JSON_OPTION },
    async executer(v) {
      if (!existsSync(chemins().base))
        throw new UserError(`Base absente (${chemins().base}) : lancez d'abord csp collecte.`);
      const { purge, formaterPurge } = await import('./purge.ts');
      const bilan = purge({ jour: await aujourdhui(), dryRun: Boolean(v['dry-run']) });
      afficher(v, bilan, () => formaterPurge(bilan));
      return 0;
    },
  },
  'a-resumer': {
    syntaxe: '[--json]',
    aide: 'Offres en attente de résumé (identifiant, raison, texte brut, titre, lien)',
    options: JSON_OPTION,
    async executer(v) {
      const { listerAResumer } = await import('./resume/resumer.ts');
      const file = await avecDepot(listerAResumer);
      afficher(v, file, () =>
        file.length
          ? file.map((a) => `${a.id_offre} (${a.raison}) ${a.titre}\n  ${a.chemin_brut}`).join('\n')
          : 'Aucune offre à résumer.',
      );
      return 0;
    },
  },
  resume: {
    syntaxe: 'enregistrer <id> <fichier.json>',
    aide: "Valide un résumé écrit à la main ou par Claude, l'enregistre, purge le texte brut",
    positionnels: 3,
    async executer(_v, [sousCommande, id, fichier]) {
      if (sousCommande !== 'enregistrer')
        throw new UserError(`Sous-commande inconnue : resume ${sousCommande}\n\n${usage()}`);
      const { enregistrerResume, lireFichierJson } = await import('./resume/resumer.ts');
      const json = lireFichierJson(fichier);
      const date = await aujourdhui();
      await avecDepot((d) => enregistrerResume(d, id, json, { date }));
      console.log(`Résumé enregistré pour ${id}, texte brut supprimé.`);
      return 0;
    },
  },
  resumer: {
    syntaxe: '[--limite <n>] [--json]',
    aide: 'Résume la file par le fournisseur du .env (CSP_LLM_FOURNISSEUR : anthropic ou albert)',
    options: { limite: { type: 'string' }, ...JSON_OPTION },
    async executer(v) {
      const limite = entierOptionnel(v.limite, 'limite');
      const { fournisseurDepuisEnv } = await import('./resume/fournisseurs.ts');
      const { resumerFile } = await import('./resume/resumer.ts');
      const fournisseur = fournisseurDepuisEnv();
      const date = await aujourdhui();
      const bilan = await avecDepot((d) => resumerFile(d, fournisseur, { date, limite }));
      afficher(v, bilan, () =>
        [
          `Fournisseur : ${bilan.fournisseur}`,
          `Résumées : ${bilan.resumees.length}, échecs : ${bilan.echecs.length}, restantes : ${bilan.restantes}`,
          ...bilan.echecs.map((e) => `  ${e.id_offre} : ${e.raison}`),
        ].join('\n'),
      );
      return 0;
    },
  },
};

const COLONNE = 29;

function usage(): string {
  const lignes = Object.entries(COMMANDES).flatMap(([nom, c]) => {
    const tete = `  ${nom}${c.syntaxe ? ` ${c.syntaxe}` : ''}`;
    const aide = c.aide.split('\n');
    const decalage = ' '.repeat(COLONNE);
    // Aide sur la même ligne si la syntaxe est courte, sinon en dessous.
    return tete.length < COLONNE
      ? [tete.padEnd(COLONNE) + aide[0], ...aide.slice(1).map((l) => decalage + l)]
      : [tete, ...aide.map((l) => decalage + l)];
  });
  return [
    'Usage : csp <commande> …',
    '',
    ...lignes,
    '',
    'Codes de sortie : 0 OK, 1 autre erreur, 2 casse du site, 3 site indisponible, 4 blocage (captcha, 403, 429).',
    'Données locales : ~/.config/csp-cli (variable CSP_HOME pour changer).',
  ].join('\n');
}

/** Options de la ligne de commande ; une erreur de saisie devient un message lisible. */
export function args(argv: string[], options: ParseArgsConfig['options'] = {}, positionnels = 0) {
  let analyse;
  try {
    analyse = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (e) {
    throw new UserError(`${(e as Error).message}\n\n${usage()}`);
  }
  const enTrop = analyse.positionals.slice(positionnels);
  if (enTrop.length) throw new UserError(`Argument(s) inattendu(s) : ${enTrop.join(' ')}\n\n${usage()}`);
  if (analyse.positionals.length < positionnels) throw new UserError(`Argument manquant.\n\n${usage()}`);
  return analyse;
}

async function main([nom, ...reste]: string[]): Promise<number> {
  const commande = nom === undefined ? undefined : COMMANDES[nom];
  if (!commande) {
    console.log(usage());
    return nom && !['-h', '--help', 'help'].includes(nom) ? 1 : 0;
  }
  const { values, positionals } = args(reste, commande.options, commande.positionnels);
  return commande.executer(values as Valeurs, positionals);
}

// Tout fichier créé par le programme (base, journaux SQLite, textes bruts, diagnostics) : lisible par l'utilisateur seul.
process.umask(0o077);
utiliserCertificatsSysteme();
appliquerProxy();
chargerEnv();

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    // Erreur connue (saisie, casse, réseau, blocage) : message seul ; sinon pile complète pour le diagnostic.
    const connue = err instanceof UserError || codeDeSortie(err) !== 1;
    console.error(connue ? (err as Error).message : err);
    if (err instanceof CasseError && err.diagnostic) console.error(`Diagnostic : ${err.diagnostic}`);
    process.exit(codeDeSortie(err));
  },
);
