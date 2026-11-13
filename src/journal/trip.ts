import type { CheckinView, PlaceView } from '../actions/types';
import type { TripData } from '../local/store';
import { type Journal, type JournalCheckin, journalOf } from './journal';

/**
 * The journal for a trip as the device holds it (`LocalStore.tripView`), for the signed-in account `me`: **their own check-ins linked to this trip** (a check-in of theirs that follows another trip, or none, is not in it) and
 * **the copies others shared with it**. Nothing else is an input, so nothing else can be seen. A thin adapter; the rules are `journal.ts`'s.
 */
export function journalOfTrip(
  data: TripData,
  tripId: string,
  checkins: readonly CheckinView[],
  places: readonly PlaceView[],
  me: string,
  now: number,
  deviceZone: string,
): Journal | undefined {
  const sets = data.sets;
  if (!sets) return undefined;
  const byId = new Map(places.map((place) => [place.id, place]));
  const own = checkins.flatMap((checkin): JournalCheckin[] => {
    const place = byId.get(checkin.placeId);
    if (checkin.tripId !== tripId || !place) return [];
    return [
      {
        id: checkin.id,
        authorId: me,
        place: {
          name: place.name,
          lat: place.lat,
          lng: place.lng,
          source: place.source,
          sourceId: place.sourceId,
        },
        at: checkin.at,
        tz: checkin.tz,
        offsetMin: checkin.offsetMin,
        note: checkin.note,
        photos: checkin.photos ?? [],
      },
    ];
  });
  const shared = data.shared.map((copy): JournalCheckin => ({
    id: copy.id,
    authorId: copy.authorId,
    place: { name: copy.place.name, lat: copy.place.lat, lng: copy.place.lng },
    at: copy.at,
    tz: copy.tz,
    offsetMin: copy.offsetMin,
    note: copy.note,
    photos: copy.photos,
  }));
  return journalOf({
    stops: sets.stops,
    days: data.days,
    items: data.items,
    members: sets.members,
    own,
    shared,
    now,
    deviceZone,
  });
}
