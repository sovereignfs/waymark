import { Placeholder } from './Placeholder';

/** The map (DESIGN.md §20.11), until 7.4 draws it. The server's page and the offline shell draw this one. */
export function MapScreen() {
  return (
    <Placeholder
      icon="map-pin"
      heading="Map"
      description="Everywhere you have checked in will be on a map here."
    />
  );
}
