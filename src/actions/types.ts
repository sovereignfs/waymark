import type { Address } from '../places/clean';
import type { CheckinRow, LinkSource, Mutation, PlaceRow } from '../sync/format';
import type { Reason } from '../checkins/validate';

/**
 * What the actions are given and what they return (DESIGN.md §15.2). **An action is a pure function from what a person meant to a mutation:** it is given what is on the screen (the rows the
 * device holds), what was asked, and a context with the things it must not read for itself, a source of ids and the time; it returns the mutation to queue, or the reason there is none, in a
 * sentence. It never reads a clock, a random number, the network or a store. The same action runs in the browser, to queue and to show at once, and in the tests, to fix its output.
 */
export interface Ids {
  /** A new id for a row or a mutation, made by the device (a UUID). */
  newId(): string;
}

/** What an action may not read for itself. */
export interface Context {
  readonly ids: Ids;
  /** Now, in milliseconds since the epoch. */
  readonly now: number;
  /** The zone the device is in: a check-in made live is in it (§7.3). */
  readonly deviceZone: string;
  /**
   * The hook of auto-link (§12): given a check-in about to be made or changed, the trip it belongs to, or none. **Empty until 9.7**: with none, no check-in is linked by the app. A link a
   * person made or removed is never asked of it.
   */
  readonly link?: AutoLink;
}

export type AutoLink = (checkin: {
  readonly at: number;
  readonly tz: string;
  readonly placeId: string;
  /**
   * The trip the app decided on, or one the person chose: **`source: 'chosen'` is the person's own word** (a check-in made from a trip's Today, for that trip's item), kept as a link by hand, so that nothing automatic, the
   * server's included, moves it to another trip with the same dates and place.
   */
}) => { readonly tripId: string; readonly source?: 'chosen' } | null;

export type ActionResult =
  | {
      readonly ok: true;
      readonly mutation: Mutation;
      /** The ids the action made, for the screen to open what was just created. */
      readonly created: { readonly placeId?: string; readonly checkinId?: string };
    }
  | { readonly ok: false; readonly reason: Reason; readonly sentence: string };

/** A place as the device holds it: its row, its id and the version the device last saw. */
export type PlaceView = PlaceRow & { readonly id: string; readonly version: number };
/** A check-in as the device holds it. */
export type CheckinView = CheckinRow & { readonly id: string; readonly version: number };

/** What a person gives to make a place: the point is what it cannot do without. */
export interface NewPlaceInput {
  readonly name: string;
  readonly lat: number;
  readonly lng: number;
  readonly address?: Address | undefined;
  readonly category?: string | undefined;
  readonly source?: PlaceRow['source'] | undefined;
  readonly sourceId?: string | undefined;
  /** A zone a person chose over the one the point is in. */
  readonly tz?: string | undefined;
}

export type { LinkSource };
