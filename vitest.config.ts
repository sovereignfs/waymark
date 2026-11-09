import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The same `@/` as tsconfig.json, so that a test can import a route or a page.
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
  test: {
    include: ['src/**/*.test.{ts,tsx}', 'proxy.test.ts', 'scripts/**/*.test.ts'],
    // The design system is shipped as ESM that imports CSS Modules. Node cannot import a .css file, so Vite has to process the package, as it
    // does a source file.
    server: { deps: { inline: [/@sovereignfs\/ui/] } },
    // The data-layer tests share one database and start each file from empty, so files run one after another. Correctness beats speed.
    fileParallelism: false,
    // A database service may be slow to answer the first time.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
