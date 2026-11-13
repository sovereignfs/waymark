import type { Map as MapComponent } from '@sovereignfs/ui/map';

/**
 * Loads the design system's map for `next/dynamic` (DESIGN.md §8.2, §21). MapLibre is a chunk of its own, fetched when a map is first drawn: with no network, or the
 * page's own chunk gone after an update, that fetch fails, and a failed `import()` in `next/dynamic` goes to the error boundary and takes the whole screen with it.
 * **A map that cannot be loaded draws nothing**, and the list or the text beside it, which is the same information, stands alone.
 */
export async function loadMap(): Promise<typeof MapComponent> {
  try {
    return (await import('@sovereignfs/ui/map')).Map;
  } catch {
    return (() => null) as unknown as typeof MapComponent;
  }
}
