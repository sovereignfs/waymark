'use client';

import { type MouseEvent, useMemo, useRef, useState, useEffect } from 'react';
import { EmptyState, FormField, Icon, Input, Button } from '@sovereignfs/ui';
import { useLocal } from '../local/LocalProvider';
import { openCheckIn } from './checkin-location';
import styles from './Timeline.module.css';
import { filterStats, placeLine, placeStats, windowRows } from './placelist';
import { categoryIcon } from './timeline';
import { usePageLocation } from './useLocation';

/** A place's row is this tall, whatever it holds: only the rows in view are drawn (the same rule as the timeline's, so ten thousand places scroll as ten do). */
const ROW = 64;

/**
 * The places (DESIGN.md §20.8): the person's own, **by how often they have been**, with a search over names, categories and addresses, all on the device. A row is a real link to `/places/<id>`, which a plain click
 * takes without the router, so it works with no network.
 */
export function PlacesList({ selectedId }: { selectedId?: string | undefined }) {
  const local = useLocal();
  const loc = usePageLocation();
  const q = new URLSearchParams(loc.search).get('q')?.slice(0, 200) ?? '';

  const stats = useMemo(
    () => placeStats(local?.places ?? [], local?.checkins ?? []),
    [local?.places, local?.checkins],
  );
  const shown = useMemo(() => filterStats(stats, q), [stats, q]);

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
  }, [local?.ready, shown.length === 0]);
  const { start, end } = windowRows(shown.length, ROW, top, height);

  if (!local || !local.ready)
    return (
      <div className={styles.root}>
        <p className={styles.count} role="status">
          Loading your places…
        </p>
      </div>
    );

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
  const carried = q ? `?${new URLSearchParams({ q }).toString()}` : '';

  return (
    <div className={styles.root}>
      <div className={styles.filters} role="search" aria-label="Find a place">
        <FormField label="Search" className={styles.search}>
          {(field) => (
            <Input
              {...field}
              type="search"
              name="q"
              autoComplete="off"
              placeholder="Names, categories and addresses"
              value={q}
              onChange={(event) => loc.setQuery({ q: event.target.value })}
            />
          )}
        </FormField>
      </div>
      <p className={styles.count} role="status">
        {q
          ? `${shown.length} of ${stats.length} places`
          : `${stats.length} ${stats.length === 1 ? 'place' : 'places'}`}
      </p>
      {stats.length === 0 ? (
        <EmptyState
          className={styles.empty}
          icon="pin"
          heading="No places yet"
          description="A place is made when you check in somewhere. The ones you have been to most are first."
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
          description="No place has all of what you typed."
          action={
            <Button
              type="button"
              variant="secondary"
              onClick={() => loc.setQuery({ q: undefined })}
            >
              Clear the search
            </Button>
          }
        />
      ) : (
        <div
          ref={scroller}
          className={styles.list}
          onScroll={(event) => setTop((event.target as HTMLDivElement).scrollTop)}
          role="list"
          aria-label="Places"
          data-rows={end - start}
        >
          <div className={styles.spacer} style={{ height: shown.length * ROW }}>
            {shown.slice(start, end).map((stat, i) => {
              const href = `/places/${stat.place.id}${carried}`;
              const line = placeLine(stat.place);
              return (
                <div
                  key={stat.place.id}
                  className={styles.item}
                  style={{ top: (start + i) * ROW, height: ROW }}
                  role="listitem"
                >
                  <a
                    href={href}
                    className={styles.row}
                    aria-current={stat.place.id === selectedId ? 'page' : undefined}
                    onClick={(event) => open(event, href)}
                  >
                    <Icon name={categoryIcon(stat.place.category)} aria-hidden />
                    <span className={styles.main}>
                      <span className={styles.name}>{stat.place.name}</span>
                      {line ? <span className={styles.line}>{line}</span> : null}
                    </span>
                    <span className={styles.visits}>
                      {stat.visits === 1 ? '1 visit' : `${stat.visits} visits`}
                    </span>
                  </a>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
