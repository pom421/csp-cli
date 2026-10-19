import { defineConfig } from 'drizzle-kit';

// `pnpm db:generer` : compare src/db/schema.ts au dernier instantané et écrit la migration SQL dans drizzle/.
// Les migrations générées sont relues et versionnées ; elles sont appliquées à l'ouverture de la base.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
