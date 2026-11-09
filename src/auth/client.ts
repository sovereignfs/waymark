'use client';

import { passkeyClient } from '@better-auth/passkey/client';
import { createAuthClient } from 'better-auth/react';
import { twoFactorClient } from 'better-auth/client/plugins';

/** better-auth in the browser, talking to `/api/auth` on the same origin. */
export const authClient = createAuthClient({ plugins: [twoFactorClient(), passkeyClient()] });
