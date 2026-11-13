import { localDate, localTime } from '../places/tz';
import { displayOrder } from '../today';
import type { DayRecord, ItemRecord, StopRecord } from '../sync/trip-format';
import type { SharedCheckin } from '../sharing/read';
import { datesText } from './trips';
import { stopsInOrder } from './plan';

/**
 * A trip's map and the list of the same (DESIGN.md §8.2, §20.10), apart from the map itself. **The list and the markers are made from the same rows**, so they cannot disagree: a row with a point is a marker, a row
 * without one is in the list and says it is not on the map. Two views of the trip:
 *
 *  - **The whole trip:** the stops in order, joined by a line, numbered; and the check-ins shared with the trip.
 *  - **One day:** that day's items **in plan order** (`displayOrder`, the order Trip Mode shows), numbered, joined by a line in that order, with the day's shared check-ins as a second kind of marker. An item with no place is
 *    listed under the day's and is not on the map; the numbers are those of the items that are.
 *
 * Pure: the rows the device holds go in, and rows, markers and a line come out.
 */
export type MapView = { readonly kind: 'trip' } | { readonly kind: 'day'; readonly dayId: string };

export type RowKind = 'stop' | 'item' | 'shared';

export interface MapRow {
  readonly id: string;
  readonly kind: RowKind;
  /** The number on the marker and in the list, for a stop or an item that is on the map. */
  readonly number?: number;
  readonly label: string;
  readonly detail: string;
  readonly point?: { readonly lat: number; readonly lng: number };
}

export interface TripMapMarker {
  readonly id: string;
  readonly lat: number;
  readonly lng: number;
  readonly label: string;
  readonly tone: 'accent' | 'success';
}

export interface TripMapModel {
  /** Everything the list shows, in the order it shows it. */
  readonly rows: readonly MapRow[];
  readonly markers: readonly TripMapMarker[];
  /** The line, in order: the stops, or the day's items. */
  readonly line: readonly { lat: number; lng: number }[];
  /** Changes when what is shown changes, so that the map fits it again. */
  readonly fitKey: string;
}

export interface TripMapInput {
  readonly stops: readonly StopRecord[];
  readonly days: readonly DayRecord[];
  readonly items: readonly ItemRecord[];
  readonly shared: readonly SharedCheckin[];
  /** Names for the authors of shared check-ins. */
  readonly names: ReadonlyMap<string, string>;
}

const sharedRow = (checkin: SharedCheckin, names: ReadonlyMap<string, string>): MapRow => {
  const who = names.get(checkin.authorId) ?? 'Someone';
  return {
    id: `shared:${checkin.id}`,
    kind: 'shared',
    label: checkin.place.name,
    detail: `${who}, ${localTime(checkin.at, checkin.tz)}, checked in`,
    point: { lat: checkin.place.lat, lng: checkin.place.lng },
  };
};

export function tripMapOf(input: TripMapInput, view: MapView): TripMapModel {
  const rows: MapRow[] = [];
  const line: { lat: number; lng: number }[] = [];
  const day = view.kind === 'day' ? input.days.find((each) => each.id === view.dayId) : undefined;

  if (view.kind === 'day' && day) {
    const items = displayOrder(input.items.filter((item) => item.dayId === day.id));
    let number = 0;
    const unplaced: MapRow[] = [];
    for (const item of items) {
      const name = item.title?.trim() || item.place?.name || 'Something planned';
      const time = item.start ? `${item.start}${item.end ? `–${item.end}` : ''}` : '';
      if (item.place) {
        number += 1;
        const point = { lat: item.place.lat, lng: item.place.lng };
        rows.push({
          id: `item:${item.id}`,
          kind: 'item',
          number,
          label: `${number}. ${name}`,
          detail: [time, item.title && item.place.name !== name ? item.place.name : '']
            .filter(Boolean)
            .join(' · '),
          point,
        });
        line.push(point);
      } else {
        unplaced.push({
          id: `item:${item.id}`,
          kind: 'item',
          label: name,
          detail: [time, 'No place, so not on the map'].filter(Boolean).join(' · '),
        });
      }
    }
    const shared = input.shared
      .filter((checkin) => localDate(checkin.at, checkin.tz) === day.date)
      .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    rows.push(...shared.map((checkin) => sharedRow(checkin, input.names)), ...unplaced);
  } else {
    const stops = stopsInOrder([...input.stops]);
    for (const [index, stop] of stops.entries()) {
      const point = { lat: stop.place.lat, lng: stop.place.lng };
      rows.push({
        id: `stop:${stop.id}`,
        kind: 'stop',
        number: index + 1,
        label: `${index + 1}. ${stop.place.name}`,
        detail: datesText(stop.arrive, stop.depart),
        point,
      });
      line.push(point);
    }
    rows.push(
      ...[...input.shared]
        .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
        .map((checkin) => sharedRow(checkin, input.names)),
    );
  }

  const markers = rows.flatMap((row): TripMapMarker[] =>
    row.point
      ? [
          {
            id: row.id,
            lat: row.point.lat,
            lng: row.point.lng,
            label: row.kind === 'shared' ? `${row.label} (checked in)` : row.label,
            tone: row.kind === 'shared' ? 'success' : 'accent',
          },
        ]
      : [],
  );
  return {
    rows,
    markers,
    line,
    fitKey: `${view.kind === 'day' && day ? day.id : 'trip'}:${markers.length}`,
  };
}
