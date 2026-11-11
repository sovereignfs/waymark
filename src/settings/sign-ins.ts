import { getAuth } from '../auth/server';

/** How an account can sign in (DESIGN.md §19.1, §21): with a password, through Sovereign, or both (DESIGN.md §19.1). Read from the sign-in store, for the Sign-in section. */
export interface SignIns {
  /** It has a password (and so can have an authenticator app and passkeys). An account that came in through Sovereign alone has none. */
  hasPassword: boolean;
  /** better-auth's id for the linked Sovereign row, to unlink it by; null when Sovereign is not linked. */
  sovereignAccountId: string | null;
}

export async function signInsOf(accountId: string): Promise<SignIns> {
  const auth = await getAuth();
  if (!auth) return { hasPassword: false, sovereignAccountId: null };
  const context = await auth.$context;
  const accounts = await context.internalAdapter.findAccounts(accountId);
  return {
    hasPassword: accounts.some((account) => account.providerId === 'credential'),
    sovereignAccountId: accounts.find((account) => account.providerId === 'sovereign')?.id ?? null,
  };
}
