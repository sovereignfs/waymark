import { sql } from 'drizzle-orm';
import { ORGANIZERS, memberOf, tableOf } from '../access/trip';
import { enqueueRelink } from '../autolink/queue';
import type { Database } from '../db/client';
import { dbAll, dbGet, transaction } from '../db/exec';
import type { Limiter } from '../limits/rate';
import { enqueueMail } from '../mail/outbox';
import type { Found as DirectoryFound, Resolved } from '../sovereign/directory';
import { enqueueCore } from '../sovereign/outbox';
import { invitationMessage } from '../mail/templates';
import { raiseNotice } from '../notices/notices';
import { getProfile } from '../profile/profile';
import { ROLES, type Role, TRIP_ID, TripError } from '../trips/format';
import type { TripDeps } from '../trips/trips';
import {
  INVITE_TTL_MS,
  MAX_PENDING,
  RESEND_AFTER_MS,
  hashToken,
  isToken,
  newToken,
  sameHash,
} from './token';

/**
 * **Invitations** (DESIGN.md §11.2): an Organizer brings people into a trip with a role, **by a name** (someone they already share a trip with, told by a notice), **by an email address** (told by a notice if an account here has it, or
 * by email, without saying which), or **by a link** to copy and send any other way. One trip, one role; the token is 32 random bytes, kept only as its hash and compared in constant time; valid 14 days, **single-use**, revocable, sent again
 * at most once an hour (a new token, so the old link stops). **Whoever holds the link can accept it**, once; the inviter is told who did. Accepting when already in the trip changes nothing and says so. Every link that cannot be used (a
 * wrong one, an expired one, a revoked one, one already used, one of a trip that is gone) is **the same answer**, so a link says nothing of why.
 *
 * Invitations are online (§15.7). The permission is in the statement: an Organizer's, for a trip that is theirs; a stranger, a Traveler and a Follower are told the trip is not there.
 */
export interface InviteDeps extends TripDeps {
  /** Counts what a person may do in an hour; absent, nothing is limited (tests). */
  readonly limiter?: Limiter | undefined;
  /** The address people use for this server, for the link; the link is a path without it. */
  readonly url?: string | undefined;
  /** The account with this email address, if there is one (the sign-in store's, where addresses are plain); absent, every address is mailed. */
  readonly accountByEmail?: ((email: string) => Promise<string | undefined>) | undefined;
  /** Core's directory, where the people sign in through a core (DESIGN.md §11.2): absent, inviting a person from it is not offered. */
  readonly coreDirectory?: InviteDirectory | undefined;
}

/**
 * What an invitation needs of core's directory, for the Organizer who is inviting: **one person looked up by their `sub`** (never taken on a browser's word), and the account here that has signed in with a `sub`, if one has.
 * Both are asked for the Organizer's own account, which finds their `sub` and their refresh token; `unavailable` is the answer when there is nothing to ask as.
 */
export interface InviteDirectory {
  search(accountId: string, query: string): Promise<DirectoryFound>;
  resolve(accountId: string, sub: string): Promise<Resolved>;
  accountOfSub(sub: string): Promise<string | undefined>;
}

export const CREATE_RATE = { limit: 60, windowMs: 3_600_000 } as const;
export const LOOKUP_RATE = { limit: 30, windowMs: 3_600_000 } as const;
/** Searching core's directory while typing a name: a search for each pause in typing, a hundred in a minute at the most for one person. */
export const DIRECTORY_RATE = { limit: 100, windowMs: 60_000 } as const;

export type Via = 'link' | 'account' | 'email' | 'directory';

export interface InvitationView {
  readonly id: string;
  readonly role: Role;
  readonly via: Via;
  /** The address it was sent to, for an Organizer to see who is waiting. */
  readonly email: string | undefined;
  /** The name core's directory gave, for an invitation made from it. */
  readonly name: string | undefined;
  readonly createdAt: number;
  readonly lastSentAt: number;
  readonly expiresAt: number;
}

export interface Sent extends InvitationView {
  /** The link to copy. Shown once: only its hash is kept. */
  readonly link: string;
  /** Whether this server can send mail (when it cannot, the link is the only way, and the dialog says so). */
  readonly mail: boolean;
}

const EMAIL = /^[^\s@<>"',;()[\]\\]+@[^\s@<>"',;()[\]\\]+\.[^\s@<>"',;()[\]\\]{2,}$/;
const bytes = (value: Uint8Array | ArrayBuffer): Uint8Array =>
  value instanceof Uint8Array ? value : new Uint8Array(value);
const linkOf = (deps: InviteDeps, token: string) => `${deps.url ?? ''}/invite/${token}`;

class NotFound extends Error {}

interface Row {
  id: string;
  role: string;
  via: string;
  createdAt: number | string;
  lastSentAt: number | string;
  expiresAt: number | string;
  sealed: Uint8Array | ArrayBuffer;
}
const COLUMNS = sql.raw(
  `i.id, i.role, i.via, i.created_at AS "createdAt", i.last_sent_at AS "lastSentAt", i.expires_at AS "expiresAt", i.sealed`,
);
const viewOf = (deps: InviteDeps, row: Row): InvitationView => ({
  id: row.id,
  role: row.role as Role,
  via: row.via as Via,
  email: deps.sealer.unseal('invitation', row.id, bytes(row.sealed)).email,
  name: deps.sealer.unseal('invitation', row.id, bytes(row.sealed)).name,
  createdAt: Number(row.createdAt),
  lastSentAt: Number(row.lastSentAt),
  expiresAt: Number(row.expiresAt),
});

async function nameOf(deps: InviteDeps, tx: Database, accountId: string): Promise<string> {
  return (await getProfile(tx, deps.sealer, accountId))?.name ?? 'Someone';
}

/** Tells the person the invitation is for: a notice if there is an account, else an email if this server has mail. */
async function deliver(
  tx: Database,
  deps: InviteDeps,
  invitation: {
    id: string;
    tripName: string;
    inviter: string;
    by: string;
    target: string | undefined;
    email: string | undefined;
    /** A person core's directory named who has no account here: told by core's bell, which their sign-in through core then follows. */
    sub?: string | undefined;
    token: string;
    /** For the key of a call to core: a new send is a new call. */
    sentAt: number;
  },
): Promise<void> {
  const link = linkOf(deps, invitation.token);
  const delivery = deps.delivery?.() ?? {};
  if (invitation.target) {
    await raiseNotice(
      tx,
      deps.sealer,
      deps.now(),
      {
        to: invitation.target,
        by: invitation.by,
        kind: 'invited',
        content: {
          title: `${invitation.inviter} invited you to “${invitation.tripName}”`,
          detail: 'Open the invitation to see the trip and join.',
          href: `/invite/${invitation.token}`,
        },
      },
      delivery,
    );
    return;
  }
  if (invitation.sub) {
    await enqueueCore(tx, deps.sealer, deps.now(), {
      kind: 'notification',
      content: {
        title: `${invitation.inviter} invited you to “${invitation.tripName}”`,
        body: 'Sign in to Waymark with your Sovereign account to join the trip.',
        path: `/invite/${invitation.token}`,
        sub: invitation.sub,
        key: `invite-${invitation.id}-${invitation.sentAt}`,
      },
    });
    return;
  }
  if (invitation.email && delivery.mail)
    await enqueueMail(tx, deps.sealer, deps.now(), {
      kind: 'notice',
      message: invitationMessage(
        delivery.mail.app,
        invitation.email,
        invitation.inviter,
        invitation.tripName,
        link,
      ),
    });
}

/** An invitation to a trip: for a person (`accountId`), for an address (`email`) or, with neither, for a link. */
export async function createInvitation(
  deps: InviteDeps,
  accountId: string,
  tripId: string,
  input: { role?: unknown; accountId?: unknown; email?: unknown; sub?: unknown },
): Promise<Sent | undefined> {
  if (!TRIP_ID.test(tripId)) return undefined;
  if (typeof input.role !== 'string' || !(ROLES as readonly string[]).includes(input.role))
    throw new TripError(`A role is one of ${ROLES.join(', ')}.`);
  const role = input.role as Role;
  const hasAccount = input.accountId !== undefined && input.accountId !== null;
  const hasEmail = input.email !== undefined && input.email !== null;
  const hasSub = input.sub !== undefined && input.sub !== null;
  if ([hasAccount, hasEmail, hasSub].filter(Boolean).length > 1)
    throw new TripError('An invitation is for a person or an address, not both.');
  if (hasSub && (typeof input.sub !== 'string' || input.sub.length < 1 || input.sub.length > 200))
    throw new TripError('That is not a person.');
  let email: string | undefined;
  if (hasEmail) {
    const raw = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
    if (raw.length > 254 || !EMAIL.test(raw)) throw new TripError('That is not an email address.');
    email = raw;
  }
  if (
    hasAccount &&
    (typeof input.accountId !== 'string' ||
      input.accountId.length < 1 ||
      input.accountId.length > 128)
  )
    throw new TripError('That is not a person.');
  const t = (name: string) => tableOf(deps.database, name);
  const now = deps.now();

  if (deps.limiter) {
    const taken = await deps.limiter.take(`invite:${accountId}`, CREATE_RATE);
    if (!taken.ok)
      throw new TripError('That is a lot of invitations for one hour. Try again later.');
  }
  // A person from core's directory is looked up again here, as the Organizer, and never taken on what a browser said of them: whether they are there, and the name core gives (which is what is kept and shown).
  let found: { sub: string; name: string } | undefined;
  if (hasSub) {
    // Only an Organizer's trip is looked up for: nothing is asked of core for anyone else, and the answer for a trip that is not theirs is the one for a trip that is not there.
    const mine = await dbGet<{ id: string }>(
      deps.database,
      sql`SELECT t.id AS id FROM ${t('trip')} t WHERE t.id = ${tripId} AND ${memberOf(deps.database, sql`t.id`, accountId, ORGANIZERS)}`,
    );
    if (!mine) return undefined;
    if (!deps.coreDirectory)
      throw new TripError(
        'There is no directory to find people in here. Use an email address or a link.',
      );
    const who = await deps.coreDirectory.resolve(accountId, input.sub as string);
    if (who.outcome === 'gone') throw new TripError('That person is not in the directory.');
    if (who.outcome !== 'found')
      throw new TripError('The directory cannot be reached now. Use an email address or a link.');
    found = { sub: who.person.sub, name: who.person.name };
  }
  // Which account, if any, an address belongs to is asked at a limited rate, so the answer cannot be mined; and it is never said.
  // A person from the directory who has signed in here is that account: told by a notice, as any account is.
  let target = hasAccount
    ? (input.accountId as string)
    : found
      ? await deps.coreDirectory?.accountOfSub(found.sub)
      : undefined;
  /** An address that belongs to someone already in the trip: the invitation is made (the answer is the same) and nothing is sent. */
  let quiet = false;
  if (email && deps.accountByEmail) {
    if (deps.limiter) {
      const taken = await deps.limiter.take(`invite-lookup:${accountId}`, LOOKUP_RATE);
      if (!taken.ok)
        throw new TripError('That is a lot of addresses for one hour. Try again later.');
    }
    target = await deps.accountByEmail(email);
  }

  try {
    return await transaction(deps.database, async (tx): Promise<Sent> => {
      const trip = await dbGet<{ sealed: Uint8Array | ArrayBuffer }>(
        tx,
        sql`SELECT t.sealed AS sealed FROM ${t('trip')} t WHERE t.id = ${tripId} AND ${memberOf(tx, sql`t.id`, accountId, ORGANIZERS)}`,
      );
      if (!trip) throw new NotFound();
      const waiting = await dbGet<{ n: number | string }>(
        tx,
        sql`SELECT COUNT(*) AS n FROM ${t('invitation')} WHERE trip_id = ${tripId} AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ${now}`,
      );
      if (Number(waiting?.n ?? 0) >= MAX_PENDING)
        throw new TripError(
          `A trip can have ${MAX_PENDING} invitations waiting. Revoke some first.`,
        );
      if (hasAccount) {
        // Only someone the Organizer already shares a trip with is offered by name: anyone else is not there.
        const shares = await dbGet<{ id: string }>(
          tx,
          sql`SELECT a.trip_id AS id FROM ${t('trip_member')} a JOIN ${t('trip_member')} b ON b.trip_id = a.trip_id
              WHERE a.account_id = ${accountId} AND a.left_at IS NULL AND b.account_id = ${target as string} AND b.left_at IS NULL LIMIT 1`,
        );
        if (!shares) throw new NotFound();
      }
      if (target) {
        const member = await dbGet<{ role: string }>(
          tx,
          sql`SELECT role FROM ${t('trip_member')} WHERE trip_id = ${tripId} AND account_id = ${target} AND left_at IS NULL`,
        );
        if (member && (hasAccount || found)) throw new TripError('They are already in this trip.');
        // An address that is already in the trip is simply not invited again, and nothing says why.
        if (member) {
          target = undefined;
          quiet = true;
        }
      }
      // One waiting invitation for a person from the directory, so that it is not made twice: it is sent again instead.
      if (found) {
        const already = await dbGet<{ id: string }>(
          tx,
          sql`SELECT id FROM ${t('invitation')}
              WHERE trip_id = ${tripId} AND (target_sub = ${found.sub} OR target_account_id = ${target ?? ''}) AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ${now}`,
        );
        if (already)
          throw new TripError('They are already invited. Send that invitation again instead.');
      }
      const { token, hash } = newToken();
      const id = crypto.randomUUID();
      const via: Via = hasAccount ? 'account' : found ? 'directory' : hasEmail ? 'email' : 'link';
      await dbAll(
        tx,
        sql`INSERT INTO ${t('invitation')} (id, trip_id, role, via, invited_by, target_account_id, target_sub, token_hash, last_sent_at, expires_at, sealed, created_at)
            VALUES (${id}, ${tripId}, ${role}, ${via}, ${accountId}, ${target ?? null}, ${found && !target ? found.sub : null}, ${hash}, ${now}, ${now + INVITE_TTL_MS},
                    ${deps.sealer.seal('invitation', id, { ...(email ? { email } : {}), ...(found ? { name: found.name } : {}) })}, ${now})
            RETURNING id`,
      );
      const tripName = deps.sealer.unseal('trip', tripId, bytes(trip.sealed)).name;
      if (!quiet)
        await deliver(tx, deps, {
          id,
          tripName,
          inviter: await nameOf(deps, tx, accountId),
          by: accountId,
          target,
          email,
          sub: found?.sub,
          token,
          sentAt: now,
        });
      return {
        id,
        role,
        via,
        email,
        name: found?.name,
        createdAt: now,
        lastSentAt: now,
        expiresAt: now + INVITE_TTL_MS,
        link: linkOf(deps, token),
        mail: deps.delivery?.().mail !== undefined,
      };
    });
  } catch (error) {
    if (error instanceof NotFound) return undefined;
    throw error;
  }
}

export interface DirectoryAnswer {
  /** `on`: asked, and these are the answer (maybe none). `off`: there is no directory to ask (not hosted, not signed in through a core, not granted): the field is Waymark's own alone. `failed`: core did not answer now. */
  readonly directory: 'on' | 'off' | 'failed';
  readonly people: readonly { readonly sub: string; readonly name: string }[];
}

/**
 * **People of the instance, for an Organizer to invite** (DESIGN.md §11.2): core's directory searched for a name, as the Organizer. **The Organizer's role is in the statement that lets the search happen**, a
 * trip that is not theirs is not there, and the search is limited. People already in the trip are left out (who they are here is known by their `sub`, never by a name or an address), and nothing is said of who has an
 * account here: every person of the directory is offered the same.
 */
export async function searchDirectory(
  deps: InviteDeps,
  accountId: string,
  tripId: string,
  query: unknown,
): Promise<DirectoryAnswer | undefined> {
  if (!TRIP_ID.test(tripId)) return undefined;
  const t = (name: string) => tableOf(deps.database, name);
  const allowed = await dbGet<{ id: string }>(
    deps.database,
    sql`SELECT t.id AS id FROM ${t('trip')} t WHERE t.id = ${tripId} AND ${memberOf(deps.database, sql`t.id`, accountId, ORGANIZERS)}`,
  );
  if (!allowed) return undefined;
  if (!deps.coreDirectory) return { directory: 'off', people: [] };
  const q = typeof query === 'string' ? query.trim() : '';
  if (q === '' || q.length > 100) return { directory: 'on', people: [] };
  if (deps.limiter) {
    const taken = await deps.limiter.take(`directory:${accountId}`, DIRECTORY_RATE);
    if (!taken.ok) throw new TripError('That is a lot of searches. Wait a moment.');
  }
  const found = await deps.coreDirectory.search(accountId, q);
  if (found.outcome === 'unavailable') return { directory: 'off', people: [] };
  if (found.outcome === 'failed') return { directory: 'failed', people: [] };
  // Not those already in this trip: an account that has signed in with their `sub` and is a member.
  const people: { sub: string; name: string }[] = [];
  for (const person of found.people) {
    const account = await deps.coreDirectory.accountOfSub(person.sub);
    if (account) {
      const member = await dbGet<{ role: string }>(
        deps.database,
        sql`SELECT role FROM ${t('trip_member')} WHERE trip_id = ${tripId} AND account_id = ${account} AND left_at IS NULL`,
      );
      if (member) continue;
    }
    people.push({ sub: person.sub, name: person.name });
  }
  return { directory: 'on', people };
}

/** The invitations of a trip that are waiting, for its Organizers: never a token. */
export async function listInvitations(
  deps: InviteDeps,
  accountId: string,
  tripId: string,
): Promise<InvitationView[] | undefined> {
  if (!TRIP_ID.test(tripId)) return undefined;
  const t = (name: string) => tableOf(deps.database, name);
  const allowed = await dbGet<{ id: string }>(
    deps.database,
    sql`SELECT t.id AS id FROM ${t('trip')} t WHERE t.id = ${tripId} AND ${memberOf(deps.database, sql`t.id`, accountId, ORGANIZERS)}`,
  );
  if (!allowed) return undefined;
  const rows = await dbAll<Row>(
    deps.database,
    sql`SELECT ${COLUMNS} FROM ${t('invitation')} i
        WHERE i.trip_id = ${tripId} AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ${deps.now()}
        ORDER BY i.created_at, i.id`,
  );
  return rows.map((row) => viewOf(deps, row));
}

/** Revokes a waiting invitation: its link stops working at once. Returns whether there was one. */
export async function revokeInvitation(
  deps: InviteDeps,
  accountId: string,
  tripId: string,
  invitationId: string,
): Promise<boolean> {
  if (!TRIP_ID.test(tripId) || !TRIP_ID.test(invitationId)) return false;
  const revoked = await dbAll<{ id: string }>(
    deps.database,
    sql`UPDATE ${tableOf(deps.database, 'invitation')} SET revoked_at = ${deps.now()}
        WHERE id = ${invitationId} AND trip_id = ${tripId} AND accepted_at IS NULL AND revoked_at IS NULL
          AND ${memberOf(deps.database, sql`${tripId}`, accountId, ORGANIZERS)}
        RETURNING id`,
  );
  return revoked.length > 0;
}

/** Sends a waiting invitation again, at most once an hour: **a new token**, so the old link stops, and a new 14 days. */
export async function resendInvitation(
  deps: InviteDeps,
  accountId: string,
  tripId: string,
  invitationId: string,
): Promise<Sent | undefined> {
  if (!TRIP_ID.test(tripId) || !TRIP_ID.test(invitationId)) return undefined;
  const t = (name: string) => tableOf(deps.database, name);
  const now = deps.now();
  try {
    return await transaction(deps.database, async (tx): Promise<Sent> => {
      const { token, hash } = newToken();
      const sent = await dbAll<Row & { target: string | null; targetSub: string | null }>(
        tx,
        sql`UPDATE ${t('invitation')} SET token_hash = ${hash}, last_sent_at = ${now}, expires_at = ${now + INVITE_TTL_MS}
            WHERE id = ${invitationId} AND trip_id = ${tripId} AND accepted_at IS NULL AND revoked_at IS NULL
              AND last_sent_at <= ${now - RESEND_AFTER_MS}
              AND ${memberOf(tx, sql`${tripId}`, accountId, ORGANIZERS)}
            RETURNING id, role, via, created_at AS "createdAt", last_sent_at AS "lastSentAt", expires_at AS "expiresAt", sealed, target_account_id AS target, target_sub AS "targetSub"`,
      );
      const row = sent[0];
      if (!row) {
        // Waiting, theirs to resend, and sent too lately: said in words. Anything else is not there.
        const waiting = await dbGet<{ lastSentAt: number | string }>(
          tx,
          sql`SELECT i.last_sent_at AS "lastSentAt" FROM ${t('invitation')} i
              WHERE i.id = ${invitationId} AND i.trip_id = ${tripId} AND i.accepted_at IS NULL AND i.revoked_at IS NULL
                AND ${memberOf(tx, sql`i.trip_id`, accountId, ORGANIZERS)}`,
        );
        if (!waiting) throw new NotFound();
        const minutes = Math.max(
          1,
          Math.ceil((Number(waiting.lastSentAt) + RESEND_AFTER_MS - now) / 60_000),
        );
        throw new TripError(
          `It was sent a moment ago. Send it again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`,
        );
      }
      const trip = await dbGet<{ sealed: Uint8Array | ArrayBuffer }>(
        tx,
        sql`SELECT sealed FROM ${t('trip')} WHERE id = ${tripId}`,
      );
      const view = viewOf(deps, row);
      await deliver(tx, deps, {
        id: row.id,
        tripName: trip ? deps.sealer.unseal('trip', tripId, bytes(trip.sealed)).name : 'a trip',
        inviter: await nameOf(deps, tx, accountId),
        by: accountId,
        target: row.target ?? undefined,
        email: view.email,
        sub: row.targetSub ?? undefined,
        token,
        sentAt: now,
      });
      return { ...view, link: linkOf(deps, token), mail: deps.delivery?.().mail !== undefined };
    });
  } catch (error) {
    if (error instanceof NotFound) return undefined;
    throw error;
  }
}

export interface Preview {
  readonly tripName: string;
  readonly startDate: string | null;
  readonly endDate: string | null;
  readonly inviter: string | undefined;
  readonly role: Role;
}

interface Found {
  id: string;
  tripId: string;
  role: string;
  invitedBy: string | null;
  tokenHash: string;
}

/** The invitation a token opens, if it opens one: waiting, not expired, of a trip that is there. Every other case is `undefined`, the same. */
async function open(tx: Database, now: number, token: string): Promise<Found | undefined> {
  if (!isToken(token)) return undefined;
  const t = (name: string) => tableOf(tx, name);
  const row = await dbGet<Found>(
    tx,
    sql`SELECT i.id AS id, i.trip_id AS "tripId", i.role AS role, i.invited_by AS "invitedBy", i.token_hash AS "tokenHash"
        FROM ${t('invitation')} i JOIN ${t('trip')} tr ON tr.id = i.trip_id
        WHERE i.token_hash = ${hashToken(token)} AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ${now}`,
  );
  return row && sameHash(row.tokenHash, token) ? row : undefined;
}

/** Whether a token opens an invitation that can still be used. For the sign-up policy `invite` (DESIGN.md §6.2), which asks it when an account is made and says nothing of why a token does not. */
export async function invitationIsOpen(
  database: Database,
  now: number,
  token: string,
): Promise<boolean> {
  return (await open(database, now, token)) !== undefined;
}

/** What the page at `/invite/<token>` shows, to anyone: the trip's name, its dates and who invited, and nothing else. */
export async function previewInvitation(
  deps: InviteDeps,
  token: string,
): Promise<Preview | undefined> {
  const found = await open(deps.database, deps.now(), token);
  if (!found) return undefined;
  const trip = await dbGet<{
    sealed: Uint8Array | ArrayBuffer;
    startDate: string | null;
    endDate: string | null;
  }>(
    deps.database,
    sql`SELECT sealed, start_date AS "startDate", end_date AS "endDate" FROM ${tableOf(deps.database, 'trip')} WHERE id = ${found.tripId}`,
  );
  if (!trip) return undefined;
  return {
    tripName: deps.sealer.unseal('trip', found.tripId, bytes(trip.sealed)).name,
    startDate: trip.startDate,
    endDate: trip.endDate,
    inviter: found.invitedBy ? await nameOf(deps, deps.database, found.invitedBy) : undefined,
    role: found.role as Role,
  };
}

export type Accepted =
  | { readonly status: 'joined'; readonly tripId: string; readonly role: Role }
  | { readonly status: 'already'; readonly tripId: string };

/**
 * Accepts the invitation a token opens, for the signed-in account: **once** (the statement that claims it names the conditions, so of two who try at the same moment one wins), adding them to the trip with the invited role. Already in the
 * trip: nothing changes, nothing is used up, and it says so. A trip that is full is refused in words and the invitation stays. The inviter is told who accepted. Anything else is `undefined`, the same for every link that cannot be used.
 */
export async function acceptInvitation(
  deps: InviteDeps,
  accountId: string,
  token: string,
): Promise<Accepted | undefined> {
  const now = deps.now();
  try {
    return await transaction(deps.database, async (tx): Promise<Accepted> => {
      const found = await open(tx, now, token);
      if (!found) throw new NotFound();
      return join(tx, deps, now, found, accountId);
    });
  } catch (error) {
    if (error instanceof NotFound) return undefined;
    throw error;
  }
}

/**
 * **A person core's directory named takes the invitations made for them by signing in through core** (DESIGN.md §11.2): called when a sign-in through core ends, with the account and its `sub`. Each waiting invitation
 * for that `sub` is accepted as an invitation is (the same statement, so once, with a full trip refused and the inviter told), in a transaction of its own, so that one that cannot be taken does not stop the others.
 * **A `sub` is identity; an email is never matched to an account** (DESIGN.md §19.1): this is the one place an invitation finds an account by anything but a link, and it is by the `sub` core vouched for in the
 * sign-in. Returns the trips joined.
 */
export async function claimInvitations(
  deps: InviteDeps,
  accountId: string,
  sub: string,
): Promise<string[]> {
  const now = deps.now();
  const t = (name: string) => tableOf(deps.database, name);
  const waiting = await dbAll<Found>(
    deps.database,
    sql`SELECT i.id AS id, i.trip_id AS "tripId", i.role AS role, i.invited_by AS "invitedBy", i.token_hash AS "tokenHash"
        FROM ${t('invitation')} i JOIN ${t('trip')} tr ON tr.id = i.trip_id
        WHERE i.target_sub = ${sub} AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ${now}
        ORDER BY i.created_at, i.id`,
  );
  const joined: string[] = [];
  for (const found of waiting) {
    try {
      const done = await transaction(deps.database, (tx) => join(tx, deps, now, found, accountId));
      if (done.status === 'joined') joined.push(done.tripId);
    } catch (error) {
      // Not here, or a full trip: this one stays waiting, with its link, and the rest are taken.
      if (!(error instanceof NotFound) && !(error instanceof TripError)) throw error;
    }
  }
  return joined;
}

/** Makes `accountId` a member for the invitation `found`, in the transaction `tx`. Throws `NotFound` for one that cannot be used any more, and `TripError` in words for a full trip. */
async function join(
  tx: Database,
  deps: InviteDeps,
  now: number,
  found: Found,
  accountId: string,
): Promise<Accepted> {
  const t = (name: string) => tableOf(tx, name);
  const me = await dbGet<{ leftAt: number | string | null }>(
    tx,
    sql`SELECT left_at AS "leftAt" FROM ${t('trip_member')} WHERE trip_id = ${found.tripId} AND account_id = ${accountId}`,
  );
  if (me && me.leftAt === null) return { status: 'already', tripId: found.tripId };
  const members = await dbGet<{ n: number | string }>(
    tx,
    sql`SELECT COUNT(*) AS n FROM ${t('trip_member')} WHERE trip_id = ${found.tripId} AND left_at IS NULL`,
  );
  if (Number(members?.n ?? 0) >= deps.limits.tripMembers)
    throw new TripError(
      'This trip already has as many people as this server allows. Ask an Organizer.',
    );
  const claimed = await dbAll<{ id: string }>(
    tx,
    sql`UPDATE ${t('invitation')} SET accepted_by = ${accountId}, accepted_at = ${now}
        WHERE id = ${found.id} AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ${now}
        RETURNING id`,
  );
  if (claimed.length === 0) throw new NotFound();
  const bumped = await dbAll<{ seq: number | string }>(
    tx,
    sql`UPDATE ${t('trip')} SET seq = seq + 1, updated_at = ${now} WHERE id = ${found.tripId} RETURNING seq`,
  );
  const trip = bumped[0];
  if (!trip) throw new NotFound();
  const seq = Number(trip.seq);
  const going = found.role !== 'follower';
  if (me)
    await dbAll(
      tx,
      sql`UPDATE ${t('trip_member')} SET role = ${found.role}, going = ${going}, share_checkins = 'ask', added_by = ${found.invitedBy}, joined_at = ${now}, left_at = NULL, seq = ${seq}
          WHERE trip_id = ${found.tripId} AND account_id = ${accountId} RETURNING account_id`,
    );
  else
    await dbAll(
      tx,
      sql`INSERT INTO ${t('trip_member')} (trip_id, account_id, role, going, share_checkins, added_by, joined_at, seq)
          VALUES (${found.tripId}, ${accountId}, ${found.role}, ${going}, 'ask', ${found.invitedBy}, ${now}, ${seq}) RETURNING trip_id`,
    );
  // A new person who goes: their check-ins that fall within the trip's dates are linked in the background.
  await enqueueRelink(tx, found.tripId, now);
  if (found.invitedBy) {
    const sealedTrip = await dbGet<{ sealed: Uint8Array | ArrayBuffer }>(
      tx,
      sql`SELECT sealed FROM ${t('trip')} WHERE id = ${found.tripId}`,
    );
    const tripName = sealedTrip
      ? deps.sealer.unseal('trip', found.tripId, bytes(sealedTrip.sealed)).name
      : 'a trip';
    await raiseNotice(
      tx,
      deps.sealer,
      now,
      {
        to: found.invitedBy,
        by: accountId,
        kind: 'invite_accepted',
        tripId: found.tripId,
        content: {
          title: `${await nameOf(deps, tx, accountId)} joined “${tripName}”`,
          detail: `They accepted your invitation as ${found.role === 'organizer' ? 'an Organizer' : found.role === 'traveler' ? 'a Traveler' : 'a Follower'}.`,
          href: `/t/${found.tripId}`,
        },
      },
      deps.delivery?.() ?? {},
    );
  }
  return { status: 'joined', tripId: found.tripId, role: found.role as Role };
}

/** Forgets invitations that were used, revoked or ran out more than a month ago. */
export async function pruneInvitations(database: Database, now: number): Promise<number> {
  const cutoff = now - 30 * 24 * 3_600_000;
  const gone = await dbAll<{ id: string }>(
    database,
    sql`DELETE FROM ${tableOf(database, 'invitation')}
        WHERE (accepted_at IS NOT NULL AND accepted_at < ${cutoff}) OR (revoked_at IS NOT NULL AND revoked_at < ${cutoff}) OR expires_at < ${cutoff}
        RETURNING id`,
  );
  return gone.length;
}
