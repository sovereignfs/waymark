import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { authSettings, getAuth } from './server';
import type { Auth } from './auth';

export type Session = NonNullable<Awaited<ReturnType<Auth['api']['getSession']>>>;

/** The signed-in person's session, or null: nobody is signed in, or sign-in is off. */
export async function getSession(): Promise<Session | null> {
  const auth = await getAuth();
  if (!auth) return null;
  return auth.api.getSession({ headers: await headers() });
}

/**
 * For a page or action that is only for someone signed in: **the account id** (better-auth's user id), which is what everything of a person is
 * owned by (AGENTS.md). Sends a visitor to sign in, and answers 404 where there is no sign-in at all.
 */
export async function requireAccount(): Promise<string> {
  return (await requireSession()).user.id;
}

/** As `requireAccount`, for a layout that also shows who the person is. */
export async function requireSession(): Promise<Session> {
  if (!authSettings()) notFound();
  const session = await getSession();
  if (!session) redirect('/sign-in');
  return session;
}
