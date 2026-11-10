import type { NextConfig } from 'next';
import { SECURITY_HEADERS } from './src/security/csp';

const config: NextConfig = {
  // One self-contained server in .next/standalone: what the image runs (see the Dockerfile, 1.10).
  output: 'standalone',
  poweredByHeader: false,
  // `next dev` would write its own block into AGENTS.md, which is the one copy of this repository's conventions and is not edited by a tool.
  agentRules: false,
  // Loaded by Node at run time, not bundled: pg is CommonJS with optional native parts, and libsql ships a native addon that only the `file:`
  // database loads.
  serverExternalPackages: ['pg', '@libsql/client', 'libsql'],
  // The headers every response has, pages and APIs alike (DESIGN.md §25). The page's own policy, which has a nonce, is the proxy's.
  async headers() {
    return [{ source: '/:path*', headers: SECURITY_HEADERS }];
  },
};

export default config;
