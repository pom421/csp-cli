#!/usr/bin/env -S node --use-system-ca --disable-warning=ExperimentalWarning
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { chargerEnv } from './config.ts';
import { codeDeSortie, UserError } from './erreurs.ts';
import { appliquerProxy, utiliserCertificatsSysteme } from './http.ts';

const USAGE = `Usage : csp <commande> …

  doctor                     Vérifie dossier local et droits, .env, recherches, accès au site et aux API
  collecte [--dry-run] [--recherche <nom>] [--json]
                             Parcourt les recherches, lit chaque offre, met la base à jour et prépare les
                             textes à résumer ; --dry-run : listes seules, comparées à la base, rien n'est écrit
  a-resumer [--json]         Offres en attente de résumé (identifiant, raison, texte brut, titre, lien)
  resume enregistrer <id> <fichier.json>
                             Valide un résumé écrit à la main ou par Claude, l'enregistre, purge le texte brut
  resumer [--limite <n>] [--json]
                             Résume la file par le fournisseur du .env (CSP_LLM_FOURNISSEUR : anthropic ou albert)

Codes de sortie : 0 OK, 1 autre erreur, 2 casse du site, 3 site indisponible, 4 blocage (captcha, 403, 429).
Données locales : ~/.config/csp-veille (variable CSP_HOME pour changer).`;

/** Options de la ligne de commande ; une erreur de saisie devient un message lisible. */
export function args(argv: string[], options: ParseArgsConfig['options'] = {}, positionals = 0) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (e) {
    throw new UserError(`${(e as Error).message}\n\n${USAGE}`);
  }
  const extra = parsed.positionals.slice(positionals);
  if (extra.length) throw new UserError(`Argument(s) inattendu(s) : ${extra.join(' ')}\n\n${USAGE}`);
  if (parsed.positionals.length < positionals) throw new UserError(`Argument manquant.\n\n${USAGE}`);
  return parsed;
}

/** Ouvre la base (qui doit exister), exécute `fn`, referme. */
async function avecDepot<T>(fn: (d: import('./db/depot.ts').Depot) => T | Promise<T>): Promise<T> {
  const { chemins } = await import('./config.ts');
  const { existsSync } = await import('node:fs');
  const { Depot } = await import('./db/depot.ts');
  const base = chemins().base;
  if (!existsSync(base)) throw new UserError(`Base absente (${base}) : lancez d'abord csp collecte.`);
  const depot = new Depot(base);
  try {
    return await fn(depot);
  } finally {
    depot.fermer();
  }
}

async function main(argv: string[]): Promise<number> {
  const [commande, ...reste] = argv;
  switch (commande) {
    case 'doctor': {
      args(reste);
      return (await import('./doctor.ts')).doctor();
    }
    case 'collecte': {
      const { values } = args(reste, {
        'dry-run': { type: 'boolean' },
        recherche: { type: 'string' },
        json: { type: 'boolean' },
      });
      const { collecte, formaterBilan } = await import('./collecte.ts');
      const bilan = await collecte({
        dryRun: Boolean(values['dry-run']),
        recherche: values.recherche as string | undefined,
      });
      console.log(values.json ? JSON.stringify(bilan, null, 2) : formaterBilan(bilan));
      return 0;
    }
    case 'a-resumer': {
      const { values } = args(reste, { json: { type: 'boolean' } });
      const { listerAResumer } = await import('./resume/resumer.ts');
      const file = await avecDepot((d) => listerAResumer(d));
      if (values.json) console.log(JSON.stringify(file, null, 2));
      else if (!file.length) console.log('Aucune offre à résumer.');
      else for (const a of file) console.log(`${a.id_offre} (${a.raison}) ${a.titre}\n  ${a.chemin_brut}`);
      return 0;
    }
    case 'resume': {
      const { positionals } = args(reste, {}, 3);
      if (positionals[0] !== 'enregistrer')
        throw new UserError(`Sous-commande inconnue : resume ${positionals[0]}\n\n${USAGE}`);
      const { enregistrerResume, lireFichierJson } = await import('./resume/resumer.ts');
      const { jourParis } = await import('./collecte.ts');
      const json = lireFichierJson(positionals[2]);
      await avecDepot((d) => enregistrerResume(d, positionals[1], json, { date: jourParis(new Date()) }));
      console.log(`Résumé enregistré pour ${positionals[1]}, texte brut supprimé.`);
      return 0;
    }
    case 'resumer': {
      const { values } = args(reste, { limite: { type: 'string' }, json: { type: 'boolean' } });
      const limite = values.limite === undefined ? Infinity : Number(values.limite);
      if (!Number.isInteger(limite) && limite !== Infinity)
        throw new UserError(`--limite attend un entier : ${String(values.limite)}`);
      const { fournisseurDepuisEnv } = await import('./resume/fournisseurs.ts');
      const { resumerFile } = await import('./resume/resumer.ts');
      const { jourParis } = await import('./collecte.ts');
      const fournisseur = fournisseurDepuisEnv();
      const bilan = await avecDepot((d) => resumerFile(d, fournisseur, { date: jourParis(new Date()), limite }));
      if (values.json) console.log(JSON.stringify(bilan, null, 2));
      else {
        console.log(`Fournisseur : ${bilan.fournisseur}`);
        console.log(
          `Résumées : ${bilan.resumees.length}, échecs : ${bilan.echecs.length}, restantes : ${bilan.restantes}`,
        );
        for (const e of bilan.echecs) console.log(`  ${e.id_offre} : ${e.raison}`);
      }
      return 0;
    }
    default:
      console.log(USAGE);
      return commande && !['-h', '--help', 'help'].includes(commande) ? 1 : 0;
  }
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
    process.exit(codeDeSortie(err));
  },
);
