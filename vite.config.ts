import { defineConfig } from 'vite-plus';

export default defineConfig({
  // drizzle/ (généré par drizzle-kit) et fixtures (HTML du site, volontairement intact) : laissés tels quels.
  fmt: { singleQuote: true, printWidth: 120, ignorePatterns: ['drizzle/**', 'src/test/fixtures/**'] },
  lint: {
    jsPlugins: [{ name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' }],
    rules: { 'vite-plus/prefer-vite-plus-imports': 'error' },
    options: { typeAware: true, typeCheck: true },
  },
  test: {
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/test/isolation.ts'],
    testTimeout: 30_000, // tests de bout en bout : binaire lancé en sous-processus
  },
  run: {
    // Scripts jamais mis en cache : `vp run csp collecte` rejouerait sinon le bilan de la veille sans rien collecter
    // (le cache ne voit que les fichiers du dépôt, pas le site ni la base). Seul `ready`, déterministe, est mis en cache.
    cache: { scripts: false, tasks: true },
    tasks: { ready: { command: 'vp check && vp test' } },
  },
});
