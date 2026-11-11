import { notFound, redirect } from 'next/navigation';
import { AuthShell } from '@/src/auth/screens/AuthShell';
import { SignInForm } from '@/src/auth/screens/SignInForm';
import { oauthErrorMessage } from '@/src/auth/messages';
import { authSettings, mailAvailable, signUpAvailable } from '@/src/auth/server';
import { getSession } from '@/src/auth/session';

// Decided per request from the settings and the visitor's cookies. Left to Next it would be prerendered at build time, with no settings, as the
// "off" 404 it would then keep.
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Sign in' };

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const settings = authSettings();
  if (!settings) notFound();
  if (await getSession()) redirect('/');
  const { error } = await searchParams;
  return (
    <AuthShell title="Sign in to Waymark">
      <SignInForm
        local={
          settings.local
            ? { canSignUp: await signUpAvailable(), canReset: mailAvailable() }
            : undefined
        }
        sovereign={settings.sovereign !== undefined}
        failure={oauthErrorMessage(typeof error === 'string' ? error : undefined)}
      />
    </AuthShell>
  );
}
