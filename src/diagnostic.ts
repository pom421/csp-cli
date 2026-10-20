// Diagnostic de casse (PLAN §6) : quand le site a changé (code 2), on garde de quoi réparer sans relancer la collecte :
// étape, message (avec le sélecteur en cause), URL et HTML de la dernière page lue. Dossier 0700, fichiers 0600,
// supprimés par `csp purge` au bout de 30 jours.
import { join } from 'node:path';
import type { CasseError } from './erreurs.ts';
import { dossierPrive, ecrireFichierPrive } from './securite/fichiers.ts';
import type { SourcePages } from './scraper/source.ts';

export interface PageLue {
  url: string;
  etape: string;
  /** Absent si la page n'a pas pu être lue (statut HTTP inattendu). */
  html?: string;
}

/** Enveloppe une source de pages pour retenir la dernière demandée : c'est celle que le code analysait à la casse. */
export function sourceMemorisante(source: SourcePages): { source: SourcePages; derniere: () => PageLue | null } {
  let derniere: PageLue | null = null;
  return {
    source: {
      async html(url, etape) {
        derniere = { url: url.href, etape };
        const html = await source.html(url, etape);
        derniere = { url: url.href, etape, html };
        return html;
      },
    },
    derniere: () => derniere,
  };
}

const heureParis = (d: Date) => d.toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour12: false });

/**
 * Écrit `diagnostics/<jour>/<HH-MM-SS>-<étape>/` (diagnostic.json, page.html) ; renvoie le chemin du dossier.
 * Le HTML vient du site : donnée non fiable, à lire comme telle, jamais exécutée.
 */
export function ecrireDiagnostic(
  dossierDiagnostics: string,
  { jour, maintenant, erreur, page }: { jour: string; maintenant: Date; erreur: CasseError; page: PageLue | null },
): string {
  // L'étape vient du code (identifiants fixes), nettoyée quand même : elle sert de nom de dossier.
  const etape = erreur.etape.replace(/[^a-z0-9-]/gi, '_').slice(0, 40);
  const dossier = join(dossierDiagnostics, jour, `${heureParis(maintenant).replaceAll(':', '-')}-${etape}`);
  dossierPrive(dossier);
  ecrireFichierPrive(
    join(dossier, 'diagnostic.json'),
    `${JSON.stringify(
      {
        date: maintenant.toISOString(),
        etape: erreur.etape,
        message: erreur.message,
        url: page?.url ?? null,
        etape_page: page?.etape ?? null,
        html: page?.html === undefined ? null : 'page.html',
      },
      null,
      2,
    )}\n`,
  );
  if (page?.html !== undefined) ecrireFichierPrive(join(dossier, 'page.html'), page.html);
  return dossier;
}
