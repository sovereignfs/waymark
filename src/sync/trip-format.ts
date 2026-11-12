import type { SharedCheckin } from '../sharing/read';
import type { AttachmentView } from '../trips/attachments';
import type { Role } from '../trips/format';
import type { ItemView, StopView } from '../trips/plan';
import type { LinkView } from '../trips/links';
import type { MemberView, TripView } from '../trips/trips';

/**
 * What a trip's stream says to a device (DESIGN.md §15.1, §15.3), types only: the server builds it (`src/sync/trips.ts`), the device reads it (`src/local/`). **A trip is one stream for each trip the account is an active member of**,
 * with its own cursor (the trip's counter). Two kinds of thing travel in it:
 *
 *  - **the small sets**, sent whole whenever the trip changed and replaced whole on the device: the trip, its members, its stops, its days, its links and (for Organizers and Travelers only) its attachments;
 *  - **the rows past the cursor**, which can be many: items and the copies of shared check-ins, with **tombstones** for the ones that were deleted.
 *
 * A Follower is never given an attachment: not a row, not a tombstone, and a device that learns it has become a Follower drops the ones it holds.
 */
export interface DayRecord {
  readonly id: string;
  readonly stopId: string;
  readonly date: string;
  readonly title: string | undefined;
  readonly notes: string | undefined;
  readonly version: number;
}

/** A stop without its days (which are their own set). */
export type StopRecord = Omit<StopView, 'days'>;
export type ItemRecord = ItemView & { readonly seq: number };

export interface TripSets {
  readonly trip: TripView;
  readonly members: MemberView[];
  readonly stops: StopRecord[];
  readonly days: DayRecord[];
  readonly links: LinkView[];
  /** The ids of the items **this account** has marked done (13.1): theirs alone, never another member's. */
  readonly done: string[];
  /** Absent for a Follower. */
  readonly attachments?: AttachmentView[];
}

export type TripTable = 'item' | 'shared_checkin';
export interface TripGone {
  readonly table: TripTable;
  readonly id: string;
  readonly seq: number;
}

export interface TripPage {
  readonly tripId: string;
  readonly role: Role;
  /** The number to ask from next. */
  readonly cursor: number;
  /** The trip's own number now. */
  readonly head: number;
  readonly floor: number;
  /** The device was behind the floor: what it holds of this trip's rows goes, and the page brings them back (§15.8). */
  readonly reset: boolean;
  readonly more: boolean;
  /** Present when the trip changed since the cursor (and always for a snapshot). */
  readonly sets?: TripSets;
  readonly items: ItemRecord[];
  readonly shared: SharedCheckin[];
  readonly deleted: TripGone[];
}

/** What a device asks of each trip it holds. */
export interface TripAsk {
  readonly cursor: number;
  readonly floor: number;
}
export type TripAsks = Readonly<Record<string, TripAsk>>;
