#!/usr/bin/env -S node --use-system-ca --disable-warning=ExperimentalWarning
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { chargerEnv } from './config.ts';
import { codeDeSortie, UserError } from './erreurs.ts';
import { appliquerProxy, utiliserCertificatsSysteme } from './http.ts';

const USAGE = `Usage : csp <commande> …

  doctor      Vérifie dossier local et droits, .env, recherches, accès au site et aux API

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

async function main(argv: string[]): Promise<number> {
  const [commande, ...reste] = argv;
  switch (commande) {
    case 'doctor': {
      args(reste);
      return (await import('./doctor.ts')).doctor();
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
