import { normalizeName } from '../places/match';
import type { TripEntry } from '../local/db';
import type { Role } from '../trips/format';

/**
 * A trip's People (DESIGN.md §11, §20.10), apart from how they look: **who may do what to whom**, who to suggest for an invitation, and the words for an invitation that is waiting. Pure, from the rows the device holds. What a
 * screen shows is only what the server would let through (`OPERATIONS` in `trips/ops.ts`, whatever this says); this keeps a screen from offering what would be refused.
 */
export interface Member {
  readonly accountId: string;
  readonly name: string;
  readonly email?: string | undefined;
  readonly role: Role;
  readonly going: boolean;
  readonly joinedAt: number;
  readonly self: boolean;
}

const ORDER: Readonly<Record<Role, number>> = { organizer: 0, traveler: 1, follower: 2 };

/** Organizers first, then Travelers, then Followers; within a role by who joined first, then name. */
export const membersInOrder = (members: readonly Member[]): Member[] =>
  [...members].sort(
    (a, b) =>
      ORDER[a.role] - ORDER[b.role] ||
      a.joinedAt - b.joinedAt ||
      a.name.localeCompare(b.name) ||
      a.accountId.localeCompare(b.accountId),
  );

export const organizersOf = (members: readonly Member[]): number =>
  members.filter((member) => member.role === 'organizer').length;

export const ROLE_HELP: Readonly<Record<Role, string>> = {
  organizer: 'Plans the trip and is responsible for it. Can invite and remove people.',
  traveler: 'Is going. Edits the plan, and can share their check-ins with the trip.',
  follower: 'Follows along from home. Reads the plan and what is shared; changes nothing.',
};

export interface Actions {
  /** Whether the role of this person can be changed from here: an Organizer's, except the last Organizer's own. */
  readonly changeRole: 'no' | 'yes' | 'last';
  /** Remove this person: an Organizer's, never for themselves (that is leaving). */
  readonly remove: boolean;
  /** Leave: everyone's own. */
  readonly leave: boolean;
  /** The _Going_ switch: an Organizer's own. */
  readonly goingSwitch: boolean;
}

/** What the reader may do about one member of the list. */
export function actionsFor(
  viewer: { readonly role: string },
  member: Member,
  organizers: number,
): Actions {
  const organizer = viewer.role === 'organizer';
  return {
    changeRole: !organizer
      ? 'no'
      : member.self && member.role === 'organizer' && organizers <= 1
        ? 'last'
        : 'yes',
    remove: organizer && !member.self,
    leave: member.self,
    goingSwitch: organizer && member.self,
  };
}

export type LeaveWay =
  /** Leaves with one press. */
  | { readonly kind: 'leave' }
  /** The last Organizer, with people who could take over: they say who. */
  | { readonly kind: 'hand-over'; readonly successors: readonly Member[] }
  /** The only one in the trip: delete it instead (the server says so too). */
  | { readonly kind: 'delete-instead' };

export function leaveWay(members: readonly Member[]): LeaveWay {
  const me = members.find((member) => member.self);
  const others = members.filter((member) => !member.self);
  // Anyone but an Organizer with no other Organizer leaves with one press.
  if (me?.role !== 'organizer' || others.some((member) => member.role === 'organizer'))
    return { kind: 'leave' };
  return others.length === 0
    ? { kind: 'delete-instead' }
    : { kind: 'hand-over', successors: membersInOrder(others) };
}

export interface Suggestion {
  readonly accountId: string;
  readonly name: string;
}

/**
 * People to suggest for an invitation by name (DESIGN.md §11.2): **those the Organizer already shares a trip with**, from the trips the device holds, who are not in this trip. Matched as place names are (no case, accents or
 * punctuation, every word), at most `limit`, by name. Names are what the Organizer's fellow members were already shown; nothing about a person who is in none of their trips is here.
 */
export function suggestPeople(
  trips: readonly TripEntry[],
  query: string,
  exclude: ReadonlySet<string>,
  limit = 6,
): Suggestion[] {
  const words = normalizeName(query).split(' ').filter(Boolean);
  if (words.length === 0) return [];
  const found = new Map<string, Suggestion>();
  for (const trip of trips)
    for (const member of trip.sets?.members ?? []) {
      if (member.self || exclude.has(member.accountId) || found.has(member.accountId)) continue;
      const name = normalizeName(member.name);
      if (words.every((word) => name.includes(word)))
        found.set(member.accountId, { accountId: member.accountId, name: member.name });
    }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, limit);
}

export interface Waiting {
  readonly id: string;
  readonly role: Role;
  readonly via: 'link' | 'account' | 'email' | 'directory';
  readonly email: string | undefined;
  /** The name core's directory gave, for an invitation made from it. */
  readonly name?: string | undefined;
  readonly lastSentAt: number;
  readonly expiresAt: number;
}

/** Who a waiting invitation is for, in words: the address, or that it is a link, or a person chosen by name. */
export const waitingFor = (invitation: Waiting): string =>
  invitation.via === 'email' && invitation.email
    ? invitation.email
    : invitation.via === 'directory'
      ? (invitation.name ?? 'A person from the instance')
      : invitation.via === 'account'
        ? 'A person chosen by name'
        : 'Anyone with the link';

/** Resent at most once an hour (DESIGN.md §11.2): the server refuses sooner, and this keeps the button from offering it. */
export const RESEND_AFTER_MS = 3_600_000;
export const canResend = (invitation: Waiting, now: number): boolean =>
  invitation.via !== 'link' && now - invitation.lastSentAt >= RESEND_AFTER_MS;

/** "Expires in 13 days", "Expires today". */
export function expiresText(invitation: Waiting, now: number): string {
  const days = Math.ceil((invitation.expiresAt - now) / 86_400_000);
  if (days <= 0) return 'Expires today';
  return days === 1 ? 'Expires tomorrow' : `Expires in ${days} days`;
}
