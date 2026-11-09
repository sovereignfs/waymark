import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema/postgres/auth.ts',
  out: './migrations/auth/postgres',
  dialect: 'postgresql',
});
