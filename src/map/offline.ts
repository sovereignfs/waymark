/**
 * Which trips' maps this device has kept (DESIGN.md §14.5), pure: a record of each trip and the files it needs, so that **a file is forgotten only when no trip that is still wanted needs it** (two stops close to each other, or two trips to the same city, share tiles). A trip's maps are
 * wanted **until it ends**; after that, or when the trip is gone, they are removed. The record is the device's own (one for each account, forgotten at sign-out), and holds no one's data: a trip's id, its last day and addresses of public map files.
 */
export interface KeptTrip {
  readonly urls: readonly string[];
  /** The trip's last day, `YYYY-MM-DD`. */
  readonly endDate: string;
}
export type Kept = Readonly<Record<string, KeptTrip>>;

/** The record with a trip's maps in it, replacing what the trip had. */
export function keepFor(
  kept: Kept,
  tripId: string,
  urls: readonly string[],
  endDate: string,
): Kept {
  return { ...kept, [tripId]: { urls: [...urls], endDate } };
}

const stillNeeded = (kept: Kept): Set<string> =>
  new Set(Object.values(kept).flatMap((trip) => trip.urls));

/** The record without a trip, and the files that only it needed. */
export function forget(kept: Kept, tripId: string): { kept: Kept; drop: string[] } {
  const leaving = kept[tripId];
  if (!leaving) return { kept, drop: [] };
  const rest = Object.fromEntries(Object.entries(kept).filter(([id]) => id !== tripId));
  const needed = stillNeeded(rest);
  return { kept: rest, drop: leaving.urls.filter((url) => !needed.has(url)) };
}

/**
 * What to let go of now: the trips whose last day is before `today`, and those that are no longer on the device (deleted, or left). `held` are the ids of the trips the device holds. Returns the record that is left and the files
 * nothing that is left needs.
 */
export function prune(
  kept: Kept,
  today: string,
  held: ReadonlySet<string>,
): { kept: Kept; drop: string[] } {
  let record = kept;
  const drop = new Set<string>();
  for (const [id, trip] of Object.entries(kept)) {
    if (trip.endDate >= today && held.has(id)) continue;
    const gone = forget(record, id);
    record = gone.kept;
    for (const url of gone.drop) drop.add(url);
  }
  // Files an earlier step let go of that a later trip needs after all are not dropped.
  const needed = stillNeeded(record);
  return { kept: record, drop: [...drop].filter((url) => !needed.has(url)) };
}

/** The key the record is kept under on this device: one for each account. */
export const keptKey = (accountId: string): string => `waymark.kept-tiles.${accountId}`;

/** Reads a record defensively: anything that is not what was written is nothing. */
export function parseKept(raw: string | null | undefined): Kept {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
    const out: Record<string, KeptTrip> = {};
    for (const [id, trip] of Object.entries(value)) {
      const t = trip as { urls?: unknown; endDate?: unknown };
      if (
        Array.isArray(t.urls) &&
        t.urls.every((u) => typeof u === 'string') &&
        typeof t.endDate === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(t.endDate)
      )
        out[id] = { urls: t.urls as string[], endDate: t.endDate };
    }
    return out;
  } catch {
    return {};
  }
}
