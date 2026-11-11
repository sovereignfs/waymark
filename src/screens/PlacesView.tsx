'use client';

import { CheckinsLayout } from './CheckinsLayout';
import { PlaceDetail } from './PlaceDetail';
import { PlacesList } from './PlacesList';
import { placeIdOf } from './placelist';
import { usePageLocation } from './useLocation';

/**
 * `/places` and `/places/<id>` (DESIGN.md §20.3, §20.8): **one page that draws what the address says**, as the timeline does, so that opening a place and coming back ask the server for nothing and work with no
 * network. A reload on `/places/<id>` is the same page, because both routes are this.
 */
export function PlacesView() {
  const loc = usePageLocation();
  const id = placeIdOf(loc.path);
  return (
    <CheckinsLayout
      list={<PlacesList selectedId={id} />}
      detail={id ? <PlaceDetail id={id} /> : undefined}
      labels={{ list: 'Places', detail: 'Place', icon: 'pin', heading: 'Choose a place' }}
    />
  );
}
