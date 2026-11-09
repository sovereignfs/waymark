import { defineConfig } from 'drizzle-kit';

// The auth store's migrations, apart from the app's: it is a separate database (an sqld
// namespace, a file, a PostgreSQL schema), so it has its own journal (DESIGN.md §22.1).
export default defineConfig({
  schema: './src/db/schema/sqlite/auth.ts',
  out: './migrations/auth/sqlite',
  dialect: 'sqlite',
});
