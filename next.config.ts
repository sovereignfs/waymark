import type { NextConfig } from 'next';

const config: NextConfig = {
  // One self-contained server in .next/standalone: what the image runs (see the Dockerfile, 1.10).
  output: 'standalone',
  poweredByHeader: false,
  // Loaded by Node at run time, not bundled: pg is CommonJS with optional native parts, and libsql ships a native addon that only the `file:`
  // database loads.
  serverExternalPackages: ['pg', '@libsql/client', 'libsql'],
};

export default config;
