import { defineConfig } from 'vite-plus';

export default defineConfig({
  fmt: { singleQuote: true, printWidth: 120 },
  lint: {
    jsPlugins: [{ name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' }],
    rules: { 'vite-plus/prefer-vite-plus-imports': 'error' },
    options: { typeAware: true, typeCheck: true },
  },
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 30_000, // tests de bout en bout : binaire lancé en sous-processus
  },
  run: { cache: true },
});
