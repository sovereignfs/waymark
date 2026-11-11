import { localDate } from '../places/tz';

/**
 * A trip's status (DESIGN.md §10.2), **computed and never stored**: `ready_at` is the only field, and everything here is a function of it, the trip's dates and the moment. Pure: it reads no database and no clock, so that the
 * server, the device and the tests all decide it the same way.
 *
 * | Status        | When                                                                  |
 * | ------------- | --------------------------------------------------------------------- |
 * | **Planning**  | Not marked ready                                                      |
 * | **Upcoming**  | Ready, and today (in the first stop's zone) is before the first day   |
 * | **Ongoing**   | Ready, and today is within the trip's dates                           |
 * | **Completed** | Ready, and today is after the last day                                |
 *
 * **Today is the date in the first stop's zone**, so a trip that begins in Auckland begins on Auckland's midnight and not on the reader's. A trip still planning whose dates have passed is _Planning_ with `datesPassed`, which is how
 * a trip planned and never marked ready still reaches its journal. **A trip that is ready and has lost its dates** (its last dated stop was removed) has nothing to decide by, and is _Planning_ until it has dates again.
 */
export type TripStatus = 'planning' | 'upcoming' | 'ongoing' | 'completed';

export interface StatusInput {
  /** When an Organizer marked it ready, or null. */
  readonly readyAt: number | null;
  readonly startDate: string | null;
  readonly endDate: string | null;
}

export interface Status {
  readonly status: TripStatus;
  /** Planning, with dates that are already over: the trip can still be marked ready to reach its journal. */
  readonly datesPassed: boolean;
  /** The date it is, in the zone the status was decided in (the first stop's). */
  readonly today: string;
}

/** The zone a status is decided in when the first stop's place has none: UTC, so that it is at least the same everywhere. */
export const FALLBACK_ZONE = 'UTC';

export function statusOf(input: StatusInput, now: number, zone: string | null | undefined): Status {
  const today = localDate(now, zone || FALLBACK_ZONE);
  const { readyAt, startDate, endDate } = input;
  if (readyAt === null || startDate === null || endDate === null)
    return {
      status: 'planning',
      datesPassed: readyAt === null && endDate !== null && today > endDate,
      today,
    };
  if (today < startDate) return { status: 'upcoming', datesPassed: false, today };
  if (today > endDate) return { status: 'completed', datesPassed: false, today };
  return { status: 'ongoing', datesPassed: false, today };
}
