import { notFound, redirect } from 'next/navigation';
import { AuthShell } from '@/src/auth/screens/AuthShell';
import { SignUpForm } from '@/src/auth/screens/SignUpForm';
import { authSettings, mailAvailable, signUpAvailable } from '@/src/auth/server';
import { getSession } from '@/src/auth/session';
import { AuthLink } from '@sovereignfs/ui';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Create an account' };

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ invite?: string | string[] }>;
}) {
  const { invite } = await searchParams;
  const token = typeof invite === 'string' ? invite : undefined;
  const settings = authSettings();
  if (!settings?.local) notFound();
  if (await getSession()) redirect('/');

  if (!(await signUpAvailable(token))) {
    return (
      <AuthShell
        title="Sign-up is closed"
        lead="Waymark is not taking new accounts. If you have one, sign in; otherwise ask whoever runs this instance."
        footer={<AuthLink href="/sign-in">Go to sign in</AuthLink>}
        footerAlign="start"
      />
    );
  }

  return (
    <AuthShell
      title="Create your account"
      footer={
        <>
          Already have an account? <AuthLink href="/sign-in">Sign in</AuthLink>
        </>
      }
    >
      <SignUpForm minLength={settings.passwordMinLength} mail={mailAvailable()} invite={token} />
    </AuthShell>
  );
}
