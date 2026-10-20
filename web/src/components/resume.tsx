// Résumé d'une offre : Markdown très simple (puces « - », **gras**) écrit par un modèle à partir du texte de l'offre.
// Donnée non fiable : découpé en éléments React (texte échappé), jamais injecté comme du HTML, aucun lien rendu.
import type { ReactNode } from 'react';

/** `**gras**` → <strong> ; le reste reste du texte brut. */
function enLigne(texte: string): ReactNode[] {
  return texte.split(/(\*\*[^*]+\*\*)/g).map((morceau, i) =>
    morceau.startsWith('**') && morceau.endsWith('**') && morceau.length > 4 ? (
      <strong key={i} className="font-semibold text-foreground">
        {morceau.slice(2, -2)}
      </strong>
    ) : (
      morceau
    ),
  );
}

export function Resume({ texte }: { texte: string }) {
  const lignes = texte
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const puces = lignes.filter((l) => /^[-*•]\s+/.test(l));
  const paragraphes = lignes.filter((l) => !/^[-*•]\s+/.test(l));
  return (
    <div className="space-y-2 text-sm leading-relaxed text-muted-foreground">
      {paragraphes.map((p, i) => (
        <p key={i}>{enLigne(p)}</p>
      ))}
      {puces.length > 0 && (
        <ul className="list-disc space-y-1.5 pl-5 marker:text-primary/60">
          {puces.map((p, i) => (
            <li key={i}>{enLigne(p.replace(/^[-*•]\s+/, ''))}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
