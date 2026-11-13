'use client';

import Link from 'next/link';
import { EmptyState, type IconName, NavTabs } from '@sovereignfs/ui';
import { goTo } from './checkin-location';
import { TripHeader } from './TripHeader';
import { PlanView } from './PlanView';
import { TripOverview } from './TripOverview';
import styles from './Trip.module.css';
import { usePageLocation } from './useLocation';
import { useTripData } from './useTrip';
import { useTripCards } from './useTrips';
import { VIEW_LABEL, type View, viewOf, viewsFor } from './trip';
import { useEffect, useState } from 'react';

const SOON: Readonly<Record<Exclude<View, 'overview' | 'plan'>, { icon: IconName; text: string }>> =
  {
    map: { icon: 'map-pin', text: 'The trip’s map is not built yet.' },
    journal: {
      icon: 'calendar-days',
      text: 'The journal, the plan beside what happened, is not built yet.',
    },
    files: { icon: 'folder-lock', text: 'The trip’s files are not built yet.' },
    people: { icon: 'users', text: 'The trip’s people are not built yet.' },
  };

/** `/t/<id>`'s id, from the address. */
export const tripIdOf = (path: string): string | undefined =>
  /^\/t\/([0-9a-zA-Z_-]{1,64})\/?$/.exec(path)?.[1];

/**
 * One trip (DESIGN.md §20.10): **one page that draws what the address says** (`/t/<id>?view=…`), from the device, so it opens with no network and changing the view is a step of the history that asks the server for
 * nothing. The views are tabs, real links, so the back button goes to the view before and a link can be copied. A trip the device does not hold says so, in the same words for one that never was, one the person left
 * and one they were removed from.
 */
export function TripPage({ id }: { id: string }) {
  const loc = usePageLocation();
  const { loading, data } = useTripData(id);
  const { cards } = useTripCards();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const card = cards.find((each) => each.id === id);

  if (loading)
    return (
      <p role="status" className={styles.page}>
        Loading the trip…
      </p>
    );
  if (!data?.sets || !card)
    return (
      <EmptyState
        icon="luggage"
        heading="This trip is not here"
        description="It may have been deleted, or you may not be a member of it."
        action={<Link href="/trips">All trips</Link>}
      />
    );

  const view = viewOf(loc.search, data.role);
  const params = new URLSearchParams(loc.search);
  const href = (each: View) => {
    const next = new URLSearchParams(params);
    if (each === 'overview') next.delete('view');
    else next.set('view', each);
    const query = next.toString();
    return `/t/${id}${query ? `?${query}` : ''}`;
  };

  return (
    <div className={styles.page}>
      <TripHeader card={card} data={data} />
      <NavTabs
        aria-label="Views of the trip"
        items={viewsFor(data.role).map((each) => ({
          label: VIEW_LABEL[each],
          href: href(each),
          active: each === view,
        }))}
        renderLink={(item, props) => (
          <a
            {...props}
            href={props.href}
            onClick={(event) => {
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
              // A step of the history, so that the back button goes to the view before; the history API and not the router, so that it asks the server for nothing.
              void goTo(item.href, 'push');
            }}
          >
            {props.children}
          </a>
        )}
      />
      {view === 'overview' ? (
        <TripOverview data={data} now={now} />
      ) : view === 'plan' ? (
        <PlanView tripId={id} data={data} />
      ) : (
        <EmptyState
          icon={SOON[view].icon}
          heading={VIEW_LABEL[view]}
          description={SOON[view].text}
        />
      )}
    </div>
  );
}
