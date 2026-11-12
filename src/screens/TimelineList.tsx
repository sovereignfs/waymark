'use client';

import { type MouseEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Button, EmptyState, FormField, Icon, Input, Select } from '@sovereignfs/ui';
import { useLocal } from '../local/LocalProvider';
import { openCheckIn } from './checkin-location';
import { PhotoImage } from './PhotoImage';
import styles from './Timeline.module.css';
import {
  type Item,
  buildItems,
  carriedQuery,
  categoryIcon,
  filterCheckins,
  filterOptions,
  heightOf,
  isFiltered,
  layout,
  offsetOfCheckin,
  parseFilters,
  windowOf,
} from './timeline';
import { DOT } from './trips';
import { usePageLocation } from './useLocation';
import { useTripCards } from './useTrips';

/**
 * The timeline (DESIGN.md §20.6): every check-in on the device, newest first, grouped by the day it was in its own zone, with the filters in the query. **Only the rows in view are drawn** (`timeline.ts`'s window,
 * over rows of a fixed height), so a decade scrolls as ten check-ins do. A row is a real link to `/c/<id>`, which a plain click takes **without the router**, so it works with no network.
 */
const dayLabel = (date: string, places: number, checkins: number) => {
  const text = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', dateStyle: 'full' }).format(
    new Date(`${date}T12:00:00Z`),
  );
  return {
    text,
    count: `${checkins} ${checkins === 1 ? 'check-in' : 'check-ins'} · ${places} ${places === 1 ? 'place' : 'places'}`,
  };
};

export function TimelineList({ selectedId }: { selectedId?: string | undefined }) {
  const local = useLocal();
  const loc = usePageLocation();
  const filters = useMemo(() => parseFilters(loc.search), [loc.search]);
  const carried = carriedQuery(loc.search);

  const placeMap = useMemo(
    () => new Map((local?.places ?? []).map((place) => [place.id, place])),
    [local?.places],
  );
  const all = local?.checkins ?? [];
  const options = useMemo(() => filterOptions(all, placeMap), [all, placeMap]);
  // The trips the device holds, for the filter and for the dot on a linked check-in.
  const { cards: trips } = useTripCards();
  const tripMap = useMemo(() => new Map(trips.map((trip) => [trip.id, trip])), [trips]);
  const shown = useMemo(() => filterCheckins(all, placeMap, filters), [all, placeMap, filters]);
  const items = useMemo(() => buildItems(shown, placeMap), [shown, placeMap]);
  const { offsets, total } = useMemo(() => layout(items), [items]);

  // The window: where the list is scrolled and how tall it is.
  const scroller = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(800);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setHeight(el.clientHeight || 800);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const { start, end } = windowOf(items, offsets, top, height);

  // A check-in that is selected is scrolled into view when the list first has it.
  const scrolledTo = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!selectedId || scrolledTo.current === selectedId) return;
    const at = offsetOfCheckin(items, offsets, selectedId);
    if (at === undefined || !scroller.current) return;
    scrolledTo.current = selectedId;
    scroller.current.scrollTop = Math.max(0, at - height / 3);
  }, [selectedId, items, offsets, height]);

  if (!local || !local.ready)
    return (
      <div className={styles.root}>
        <p className={styles.count} role="status">
          Loading your check-ins…
        </p>
      </div>
    );

  const set = (patch: Record<string, string | undefined>) => loc.setQuery(patch);
  const clear = () =>
    set({
      year: undefined,
      category: undefined,
      country: undefined,
      trip: undefined,
      q: undefined,
    });
  const open = (event: MouseEvent<HTMLAnchorElement>, href: string) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    loc.push(href);
  };

  const draw = (item: Item, index: number) => {
    const style = { top: offsets[index], height: heightOf(item) };
    if (item.kind === 'day') {
      const label = dayLabel(item.date, item.places, item.checkins);
      return (
        <div
          key={`d${item.date}${index}`}
          className={`${styles.item} ${styles.day}`}
          style={style}
          role="listitem"
        >
          <h3>{label.text}</h3>
          <span>{label.count}</span>
        </div>
      );
    }
    const href = `/c/${item.checkin.id}${carried}`;
    const linked = item.checkin.tripId ? tripMap.get(item.checkin.tripId) : undefined;
    return (
      <div key={item.checkin.id} className={styles.item} style={style} role="listitem">
        <a
          href={href}
          className={styles.row}
          aria-current={item.checkin.id === selectedId ? 'page' : undefined}
          onClick={(event) => open(event, href)}
        >
          <span className={styles.time}>{item.time}</span>
          <Icon name={categoryIcon(item.place?.category)} aria-hidden />
          <span className={styles.main}>
            <span className={styles.name}>
              {item.place?.name ?? 'A place'}
              {linked ? (
                <span
                  className={styles.tripDot}
                  style={{ background: DOT[linked.color] }}
                  role="img"
                  aria-label={`Part of ${linked.name}`}
                  title={linked.name}
                />
              ) : null}
            </span>
            {item.line ? <span className={styles.line}>{item.line}</span> : null}
          </span>
          {item.photo ? (
            <span className={styles.thumb}>
              <PhotoImage id={item.photo} thumb alt="First photo" />
            </span>
          ) : null}
        </a>
      </div>
    );
  };

  return (
    <div className={styles.root}>
      <div className={styles.filters} role="search" aria-label="Filter check-ins">
        <FormField label="Search" className={styles.search}>
          {(field) => (
            <Input
              {...field}
              type="search"
              name="q"
              autoComplete="off"
              placeholder="Places and notes"
              value={filters.q}
              onChange={(event) => set({ q: event.target.value })}
            />
          )}
        </FormField>
        <FormField label="Year">
          {(field) => (
            <Select
              {...field}
              name="year"
              value={filters.year ? String(filters.year) : ''}
              onChange={(event) => set({ year: event.target.value })}
            >
              <option value="">All</option>
              {options.years.map((year) => (
                <option key={year} value={year}>
                  {year}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        <FormField label="Category">
          {(field) => (
            <Select
              {...field}
              name="category"
              value={filters.category ?? ''}
              onChange={(event) => set({ category: event.target.value })}
            >
              <option value="">All</option>
              {options.categories.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        <FormField label="Country">
          {(field) => (
            <Select
              {...field}
              name="country"
              value={filters.country ?? ''}
              onChange={(event) => set({ country: event.target.value })}
            >
              <option value="">All</option>
              {options.countries.map((country) => (
                <option key={country} value={country}>
                  {country}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        {trips.length > 0 ? (
          <FormField label="Trip">
            {(field) => (
              <Select
                {...field}
                name="trip"
                value={filters.trip ?? ''}
                onChange={(event) => set({ trip: event.target.value })}
              >
                <option value="">All</option>
                {trips.map((trip) => (
                  <option key={trip.id} value={trip.id}>
                    {trip.name}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
        ) : null}
        {isFiltered(filters) ? (
          <Button type="button" variant="secondary" onClick={clear}>
            Clear
          </Button>
        ) : null}
      </div>
      <p className={styles.count} role="status">
        {isFiltered(filters)
          ? `${shown.length} of ${all.length} check-ins`
          : `${all.length} ${all.length === 1 ? 'check-in' : 'check-ins'}`}
      </p>
      {all.length === 0 ? (
        <EmptyState
          className={styles.empty}
          icon="map-pin"
          heading="No check-ins yet"
          description="Where you check in will be here, newest first."
          action={
            <Button type="button" onClick={() => openCheckIn()}>
              Check in
            </Button>
          }
        />
      ) : shown.length === 0 ? (
        <EmptyState
          className={styles.empty}
          icon="search"
          heading="Nothing matches"
          description="No check-in has all of what you filtered by."
          action={
            <Button type="button" variant="secondary" onClick={clear}>
              Clear the filters
            </Button>
          }
        />
      ) : (
        <div
          ref={scroller}
          className={styles.list}
          onScroll={(event) => setTop((event.target as HTMLDivElement).scrollTop)}
          role="list"
          aria-label="Check-ins"
          data-rows={end - start}
        >
          <div className={styles.spacer} style={{ height: total }}>
            {items.slice(start, end).map((item, i) => draw(item, start + i))}
          </div>
        </div>
      )}
    </div>
  );
}
