import { AuthShell } from '@/src/auth/screens/AuthShell';
import { authSettings, signUpAvailable } from '@/src/auth/server';
import { getSession } from '@/src/auth/session';
import { JoinTrip } from '@/src/invitations/JoinTrip';
import { preview } from '@/src/invitations/http';
import { serverInvite } from '@/src/invitations/server';
import type { Preview } from '@/src/invitations/service';
import { AuthLink } from '@sovereignfs/ui';

export const dynamic = 'force-dynamic';
// The address holds the token: it is sent nowhere (no referrer), and a search engine is asked to leave it alone.
export const metadata = { title: 'Invitation', referrer: 'no-referrer', robots: { index: false } };

const range = (from: string | null, to: string | null): string => {
  if (!from) return 'No dates yet';
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', dateStyle: 'medium' });
  const day = (date: string) => f.format(new Date(`${date}T12:00:00Z`));
  return to && to !== from ? `${day(from)} to ${day(to)}` : day(from);
};

/**
 * `/invite/<token>` (DESIGN.md §11.2): **what whoever holds the link sees before signing in**: the trip's name, its dates and who invited, and nothing else, then the way in. Signed in, one press joins the trip. Not signed in,
 * the person signs in (and comes back here) or, where the server takes accounts by invitation, creates one. **Every link that cannot be used is the same page**, so a link says nothing of why.
 */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const reply = await preview(token, await serverInvite());
  if (!reply.ok)
    return (
      <AuthShell
        title="This invitation cannot be used"
        lead="The link may have expired, been used or been withdrawn. Ask whoever sent it for a new one."
        footer={<AuthLink href="/">Go to Waymark</AuthLink>}
        footerAlign="start"
      />
    );
  const found = (await reply.json()) as Preview;
  const signedIn = (await getSession()) !== null;
  const settings = authSettings();
  const canCreate = settings?.local === true && (await signUpAvailable(token));
  const lead = `${found.inviter ? `${found.inviter} invited you` : 'You are invited'} to ${found.tripName}, ${range(found.startDate, found.endDate)}.`;

  return (
    <AuthShell
      title={found.tripName}
      lead={lead}
      footer={
        signedIn ? undefined : (
          <>
            {settings ? (
              <>
                Already have an account?{' '}
                <AuthLink href={`/sign-in?next=/invite/${token}`}>Sign in</AuthLink>
              </>
            ) : null}
            {canCreate ? (
              <>
                {' '}
                or <AuthLink href={`/sign-up?invite=${token}`}>create an account</AuthLink>
              </>
            ) : null}
          </>
        )
      }
      footerAlign="start"
    >
      {signedIn ? <JoinTrip token={token} /> : null}
    </AuthShell>
  );
}
