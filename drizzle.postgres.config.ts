import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema/postgres/app.ts',
  out: './migrations/postgres',
  dialect: 'postgresql',
});
