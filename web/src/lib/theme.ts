import { useEffect, useState } from 'react';

type Theme = 'clair' | 'sombre';

const CLE = 'csp-theme';

/** Préférence gardée dans le navigateur (si permis) ; par défaut, celle du système. */
function initial(): Theme {
  try {
    const garde = localStorage.getItem(CLE);
    if (garde === 'clair' || garde === 'sombre') return garde;
  } catch {
    // Stockage refusé (navigation privée) : préférence du système.
  }
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'sombre' : 'clair';
}

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(initial);
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'sombre');
    document.documentElement.style.colorScheme = theme === 'sombre' ? 'dark' : 'light';
  }, [theme]);
  const basculer = () =>
    setTheme((t) => {
      const suivant = t === 'clair' ? 'sombre' : 'clair';
      try {
        localStorage.setItem(CLE, suivant);
      } catch {
        // Sans stockage, le choix vaut pour la page seulement.
      }
      return suivant;
    });
  return [theme, basculer];
}
