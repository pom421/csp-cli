// Application de consultation des offres, servie par `csp web` (src/web/serveur.ts) une fois compilée dans web/dist.
// `vp run web:dev` : rechargement à chaud, l'API vient de `csp web` lancé à côté (port 4321).
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': new URL('./src', import.meta.url).pathname } },
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    proxy: { '/api': { target: 'http://127.0.0.1:4321', headers: { host: '127.0.0.1:4321' } } },
  },
});
