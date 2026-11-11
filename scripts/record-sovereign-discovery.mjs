// Record a Sovereign instance's public OIDC discovery document, for the test that ties the
// fake Sovereign to the real one (src/auth/sovereign-discovery.test.ts).
//
//   node scripts/record-sovereign-discovery.mjs https://auth.sovereign.example.com/api/auth
//
// It makes one unauthenticated GET of a public document and needs no credential. Read the diff
// before committing it: a change here is a change on Sovereign's side.
import { writeFileSync } from 'node:fs';

const issuer = (process.argv[2] ?? 'https://auth.sovereign.openfs.io/api/auth').replace(/\/+$/, '');
const response = await fetch(`${issuer}/.well-known/openid-configuration`, {
  headers: { accept: 'application/json' },
});
if (!response.ok) {
  console.error(`${issuer} answered ${response.status}`);
  process.exit(1);
}
const document = await response.json();
const out = new URL('../src/auth/fixtures/sovereign-discovery.json', import.meta.url);
writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`);
console.log(`recorded ${issuer} to ${out.pathname}`);
