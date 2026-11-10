'use client';

import { CheckinDetail } from './CheckinDetail';
import { CheckinsLayout } from './CheckinsLayout';
import { TimelineList } from './TimelineList';
import { checkinIdOf } from './timeline';
import { usePageLocation } from './useLocation';

/**
 * `/checkins` and `/c/<id>` (DESIGN.md §20.3, §20.6): **one page that draws what the address says**, so that opening a check-in, changing a filter and coming back are changes of the address in the page and ask the
 * server for nothing, and work with no network. A reload on `/c/<id>` is the same page, because both routes are this.
 */
export function CheckinsView() {
  const loc = usePageLocation();
  const id = checkinIdOf(loc.path);
  return (
    <CheckinsLayout
      list={<TimelineList selectedId={id} />}
      detail={id ? <CheckinDetail id={id} /> : undefined}
    />
  );
}
