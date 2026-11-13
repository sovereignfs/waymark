'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { type Identity, readIdentity } from '../identity';
import { offlineScreenOf } from '../sw/addresses';
import { CheckinsView } from './CheckinsView';
import { HomeScreen } from './HomeScreen';
import { MapScreen } from './MapScreen';
import { PlacesView } from './PlacesView';
import { SignedInArea } from './SignedInArea';
import { TripMode } from './TripModeScreen';
import { TripPage, tripIdOf } from './TripPage';
import { TripsView } from './TripsView';
import { usePageLocation } from './useLocation';

/**
 * The app with no server document (DESIGN.md §20.12; 6.4). The service worker answers the app's screens with the one page it keeps, `/shell`, which holds nothing of a person and is the same for everyone;
 * this is what that page is. It finds who is signed in on the device (`src/identity.ts`), makes the same composition the server's layout makes, and **chooses the screen from the address**, since the page it
 * came in is not the page of the address (`src/sw/addresses.ts` is the list both agree on). The screens read the device's store and write through it, so they need none of the server.
 */
function Screen() {
  const { path } = usePageLocation();
  switch (offlineScreenOf(path)) {
    case 'checkins':
      return <CheckinsView />;
    case 'places':
      return <PlacesView />;
    case 'trips':
      return <TripsView />;
    case 'tripmode': {
      const id = /^\/t\/([^/]+)\/today$/.exec(path)?.[1];
      return id ? <TripMode id={id} /> : <TripsView />;
    }
    case 'trip': {
      const id = tripIdOf(path);
      return id ? <TripPage id={id} /> : <TripsView />;
    }
    case 'map':
      return <MapScreen />;
    default:
      return <HomeScreen />;
  }
}

export function OfflineApp() {
  // Not known until the page is in the browser: the server renders nothing of a person.
  const [who, setWho] = useState<Identity | null | undefined>(undefined);
  useEffect(() => setWho(readIdentity()), []);

  if (who === undefined) return null;
  if (who === null)
    return (
      <main style={{ padding: 'var(--sv-space-6)' }}>
        <p>Sign in to use Waymark. This needs a connection.</p>
        <p>
          <Link href="/sign-in">Sign in</Link>
        </p>
      </main>
    );
  return (
    <SignedInArea accountId={who.id} name={who.name} email={who.email}>
      <Screen />
    </SignedInArea>
  );
}
