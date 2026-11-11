/**
 * Who a check-in is shared with (DESIGN.md §11.3), pure, with no database: the one place the three choices are put together, used by the server when it applies a check-in and by the device when 6.6 puts trips on it.
 *
 * **A check-in is private to its author, even when it is linked to a shared trip.** It reaches the trip's other members only when
 *  - it is linked to the trip and its author is still an Organizer or a Traveler of it (a Follower's check-ins never link or share), and
 *  - the check-in says **`on`**, or says **`trip`** (follow the trip) and the author's choice for that trip is `on`.
 * `off` on the check-in keeps it private whatever the trip says. A choice for a trip is the author's `on` or `off`; one that is still `ask` is answered by their default in Settings (`on` or `off`) and, if that is `ask` too, is not
 * answered yet: **nothing is shared until the person has said so**, and the screen asks once (the question is `needsAnswer`).
 */
export type ShareChoice = 'ask' | 'on' | 'off';
export type CheckinShare = 'trip' | 'on' | 'off';

export const SHARE_CHOICES: readonly ShareChoice[] = ['ask', 'on', 'off'];

/** What a person's choice for a trip comes to: theirs if they have made it, otherwise their default, otherwise still to be asked. */
export function choiceFor(forTrip: ShareChoice, defaultChoice: ShareChoice): ShareChoice {
  if (forTrip !== 'ask') return forTrip;
  return defaultChoice;
}

export interface ShareFacts {
  /** The check-in's own word: `trip`, `on` or `off`. */
  readonly share: CheckinShare;
  /** The trip the check-in is linked to, if any. */
  readonly tripId: string | null;
  /** Whether the author is, now, an Organizer or a Traveler of that trip. */
  readonly authorMay: boolean;
  /** The author's choice for that trip (`trip_member.share_checkins`). */
  readonly forTrip: ShareChoice;
  /** The author's default (Settings > Check-ins). */
  readonly defaultChoice: ShareChoice;
}

/** The trip a check-in is shared with, or undefined if it is private. */
export function sharedWith(facts: ShareFacts): string | undefined {
  if (facts.tripId === null || !facts.authorMay) return undefined;
  if (facts.share === 'off') return undefined;
  if (facts.share === 'on') return facts.tripId;
  return choiceFor(facts.forTrip, facts.defaultChoice) === 'on' ? facts.tripId : undefined;
}

/**
 * Whether the screen should ask "Share your check-ins on <trip> with its N members?": a check-in that follows the trip, is linked to one the author may share on, the trip has other members, and the author has not
 * answered (neither for the trip nor in Settings).
 */
export function needsAnswer(facts: ShareFacts, otherMembers: number): boolean {
  return (
    facts.tripId !== null &&
    facts.authorMay &&
    facts.share === 'trip' &&
    otherMembers > 0 &&
    choiceFor(facts.forTrip, facts.defaultChoice) === 'ask'
  );
}
