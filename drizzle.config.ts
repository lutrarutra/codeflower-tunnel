import { defineConfig } from 'drizzle-kit';

// The same migrations run on D1 (`wrangler d1 migrations apply`) and on the
// self-hosted SQLite file (applied at startup by src/node.ts).
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './migrations'
});
