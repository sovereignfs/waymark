import type { AutoLink } from '../actions/types';
import type { TripEntry } from '../local/db';
import { type Candidate, decide } from './decide';

/**
 * Auto-link as the device runs it (DESIGN.md §12): **the trips the device holds, as candidates**, and the hook an action asks when a check-in is made or changed, so that a check-in falls into its trip at once, with no network
 * (the server decides again when it applies the change, and its answer stands). The rule is `decide`'s, the same pure function: this only says which trips are candidates and where their stops are.
 *
 * A trip is a candidate for someone who **goes**: a Traveler, or an Organizer who is going; a Follower has no check-ins in a trip. A trip with no dates is none, and a stop with no dates is not on any day.
 */
export function candidatesOf(trips: readonly TripEntry[]): Candidate[] {
  return trips.flatMap((entry): Candidate[] => {
    const sets = entry.sets;
    if (!sets) return [];
    const { trip } = sets;
    return [
      {
        id: entry.id,
        createdAt: trip.createdAt,
        goes: entry.role === 'traveler' || (entry.role === 'organizer' && trip.going),
        startDate: trip.startDate,
        endDate: trip.endDate,
        stops: sets.stops.flatMap((stop) =>
          stop.arrive !== null && stop.depart !== null
            ? [
                {
                  arrive: stop.arrive,
                  depart: stop.depart,
                  point: { lat: stop.place.lat, lng: stop.place.lng },
                },
              ]
            : [],
        ),
      },
    ];
  });
}

/** The hook for `Context.link`: the trip a check-in at a place, at a moment, falls into, or none. `placeId` is the person's own place, whose point is where the check-in is. */
export function autoLinkFor(
  trips: readonly TripEntry[],
  places: readonly { readonly id: string; readonly lat: number; readonly lng: number }[],
): AutoLink {
  const candidates = candidatesOf(trips);
  const byId = new Map(places.map((place) => [place.id, place]));
  return ({ at, tz, placeId }) => {
    const place = byId.get(placeId);
    const id = decide(
      { at, tz, ...(place ? { point: { lat: place.lat, lng: place.lng } } : {}) },
      candidates,
    );
    return id ? { tripId: id } : null;
  };
}
