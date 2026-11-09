import { notFound } from 'next/navigation';
import { AuthShell } from '@/src/auth/screens/AuthShell';
import { ResetForm } from '@/src/auth/screens/ResetForm';
import { authSettings, mailAvailable } from '@/src/auth/server';
import { AuthLink } from '@sovereignfs/ui';

// Choosing a new password with the link that was sent (DESIGN.md §6). The token is in the address, is good once, and is read by the form in the browser.
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Choose a new password' };

export default async function ResetPasswordPage() {
  const settings = authSettings();
  if (!settings || !mailAvailable()) notFound();
  return (
    <AuthShell
      title="Choose a new password"
      footer={<AuthLink href="/sign-in">Back to sign in</AuthLink>}
    >
      <ResetForm minLength={settings.passwordMinLength} />
    </AuthShell>
  );
}
