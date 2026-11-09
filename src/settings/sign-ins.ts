import { getAuth } from '../auth/server';

/** How an account can sign in (DESIGN.md §19.1, §21): with a password, or through Sovereign (2.3). Read from the sign-in store, for the Sign-in section. */
export interface SignIns {
  /** It has a password (and so can have an authenticator app and passkeys). An account that came in through Sovereign alone has none. */
  hasPassword: boolean;
}

export async function signInsOf(accountId: string): Promise<SignIns> {
  const auth = await getAuth();
  if (!auth) return { hasPassword: false };
  const context = await auth.$context;
  const accounts = await context.internalAdapter.findAccounts(accountId);
  return { hasPassword: accounts.some((account) => account.providerId === 'credential') };
}
