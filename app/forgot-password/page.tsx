import { notFound, redirect } from 'next/navigation';
import { AuthShell } from '@/src/auth/screens/AuthShell';
import { ForgotForm } from '@/src/auth/screens/ForgotForm';
import { mailAvailable } from '@/src/auth/server';
import { getSession } from '@/src/auth/session';
import { AuthLink } from '@sovereignfs/ui';

// Asking for a link to choose a new password (DESIGN.md §6). Only with mail: without it there is nothing to send, and the page is not there.
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Forgot your password' };

export default async function ForgotPasswordPage() {
  if (!mailAvailable()) notFound();
  if (await getSession()) redirect('/');
  return (
    <AuthShell
      title="Forgot your password?"
      lead="Give the address you signed up with, and a link to choose a new password is sent to it."
      footer={<AuthLink href="/sign-in">Back to sign in</AuthLink>}
    >
      <ForgotForm />
    </AuthShell>
  );
}
