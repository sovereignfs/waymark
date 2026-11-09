/**
 * **The one function that decides what of a profile another person sees** (DESIGN.md §6.1), used by every read that returns a profile. Names are seen by everyone who
 * shares a trip with the person; **an email is seen by the person themselves and by the Organizers of a trip they are in, and by nobody else**: never by a Traveler or a
 * Follower, never in a notice and never in someone else's export. A reader who may see nothing of the person is told the same as if there were no such person.
 *
 * What the relation is, is for the caller's statement to say (a person's own row; membership of a trip with the role, `src/access/` fragments, §5.2): this only turns
 * a relation into what is shown, so that no read decides it for itself.
 */
export type Relation =
  /** The person themselves. */
  | 'self'
  /** The reader is an Organizer of a trip the person is an active member of. */
  | 'organizer'
  /** The reader and the person are active members of a trip, in any role, and the reader is not its Organizer. */
  | 'member'
  /** The reader shares nothing with the person. */
  | 'none';

export interface ProfileFields {
  readonly accountId: string;
  readonly name: string;
  readonly email: string;
}

/** What a reader is given of a profile: always a name, and an email only where §6.1 allows it. */
export interface VisibleProfile {
  readonly accountId: string;
  readonly name: string;
  readonly email?: string;
}

const SEES_EMAIL: Readonly<Record<Relation, boolean>> = {
  self: true,
  organizer: true,
  member: false,
  none: false,
};

/** Whether a reader with this relation to a person may see their email. */
export const canSeeEmail = (relation: Relation): boolean => SEES_EMAIL[relation];

/** The profile as a reader may see it, or `undefined` when they may see nothing of the person (and are told what they would be told if there were none). */
export function visibleProfile(
  profile: ProfileFields,
  relation: Relation,
): VisibleProfile | undefined {
  if (relation === 'none') return undefined;
  return canSeeEmail(relation)
    ? { accountId: profile.accountId, name: profile.name, email: profile.email }
    : { accountId: profile.accountId, name: profile.name };
}
