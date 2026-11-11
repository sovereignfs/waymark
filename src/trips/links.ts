import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { EDITORS, MEMBERS, memberOf, tableOf } from '../access/trip';
import type { Database } from '../db/client';
import { dbAll, dbGet, transaction } from '../db/exec';
import { after, between, first } from '../position';
import { recordGone } from './gone';
import { TRIP_ID } from './format';
import { type LinkKind, MAX_LINKS, checkLink } from './link-format';
import type { TripDeps } from './trips';

/**
 * A trip's links (DESIGN.md §10.7): up to ten, each a title and an `https` address, the first kind being _Expenses in Tally_. **Every member reads them, Followers too; Organizers and Travelers add, change, reorder and remove
 * them** (§11.1), the permission in each statement (`src/access/trip.ts`), a change one transaction that begins with the guarded `UPDATE trip` that carries it. The title and the address are sealed.
 *
 * **Nothing in this file, or in anything it imports, makes a request to a link's address**: a link is stored and shown, never fetched, never previewed, and Waymark knows nothing of Tally beyond the kind a person chose and the
 * address (no app imports another). A test runs every operation with the network refused and reads this file for the calls it must not make.
 */
export interface LinkView {
  readonly id: string;
  readonly kind: LinkKind;
  readonly title: string;
  readonly url: string;
  readonly position: string;
}

/** A link the trip would not take, with a sentence of its own that repeats nothing typed. */
export class LinkRefused extends Error {
  override name = 'LinkRefused';
  constructor(
    readonly reason: 'invalid' | 'limit',
    readonly sentence: string,
  ) {
    super(sentence);
  }
}

const bytes = (value: Uint8Array | ArrayBuffer): Uint8Array =>
  value instanceof Uint8Array ? value : new Uint8Array(value);

interface Row {
  id: string;
  kind: string;
  position: string;
  sealed: Uint8Array | ArrayBuffer;
}

function viewOf(deps: TripDeps, row: Row): LinkView {
  const fields = deps.sealer.unseal('trip_link', row.id, bytes(row.sealed));
  return {
    id: row.id,
    kind: row.kind as LinkKind,
    title: fields.title,
    url: fields.url,
    position: row.position,
  };
}

/** The links of a trip as every member may read them, in their order, or `undefined` for a trip the caller is not in. */
export async function listLinks(
  deps: TripDeps,
  accountId: string,
  tripId: string,
): Promise<LinkView[] | undefined> {
  if (!TRIP_ID.test(tripId)) return undefined;
  const { database } = deps;
  const member = await dbGet<{ id: string }>(
    database,
    sql`SELECT t.id AS id FROM ${tableOf(database, 'trip')} t WHERE t.id = ${tripId} AND ${memberOf(database, sql`t.id`, accountId, MEMBERS)}`,
  );
  if (!member) return undefined;
  const rows = await dbAll<Row>(
    database,
    sql`SELECT l.id, l.kind, l.position, l.sealed FROM ${tableOf(database, 'trip_link')} l
        WHERE l.trip_id = ${tripId} AND ${memberOf(database, sql`l.trip_id`, accountId, MEMBERS)}
        ORDER BY l.position, l.id`,
  );
  return rows.map((row) => viewOf(deps, row));
}

class NotFound extends Error {}

/** One change to a trip's links by an Organizer or a Traveler; the links after it, or `undefined` for a trip the caller cannot change (or a link that is not this trip's). A refusal throws and keeps nothing. */
async function change(
  deps: TripDeps,
  accountId: string,
  tripId: string,
  work: (tx: Database, seq: number) => Promise<void>,
): Promise<LinkView[] | undefined> {
  if (!TRIP_ID.test(tripId)) return undefined;
  const now = deps.now();
  try {
    const allowed = await transaction(deps.database, async (tx) => {
      const touched = await dbAll<{ seq: number | string }>(
        tx,
        sql`UPDATE ${tableOf(tx, 'trip')} SET seq = seq + 1, updated_at = ${now}
            WHERE id = ${tripId} AND ${memberOf(tx, sql`${tripId}`, accountId, EDITORS)}
            RETURNING seq`,
      );
      if (!touched[0]) return false;
      await work(tx, Number(touched[0].seq));
      return true;
    });
    if (!allowed) return undefined;
  } catch (error) {
    if (error instanceof NotFound) return undefined;
    throw error;
  }
  return listLinks(deps, accountId, tripId);
}

const positionsOf = (tx: Database, tripId: string, except?: string) =>
  dbAll<{ id: string; position: string }>(
    tx,
    sql`SELECT id, position FROM ${tableOf(tx, 'trip_link')} WHERE trip_id = ${tripId} ORDER BY position, id`,
  ).then((rows) => (except ? rows.filter((row) => row.id !== except) : rows));

/** A position just before `beforeId` (at the end with none); a neighbour that is not one of this trip's links is not found. */
function placeBefore(
  list: readonly { id: string; position: string }[],
  beforeId: string | null | undefined,
): string {
  if (beforeId === null || beforeId === undefined)
    return list.length === 0 ? first() : after(list.at(-1)?.position ?? '');
  const index = list.findIndex((row) => row.id === beforeId);
  if (index < 0) throw new NotFound();
  return between(
    index === 0 ? null : (list[index - 1]?.position ?? null),
    list[index]?.position ?? null,
  );
}

export interface NewLink {
  readonly kind?: unknown;
  readonly title?: unknown;
  readonly url: unknown;
  /** The link it is put before; at the end with none. */
  readonly before?: string | null;
}

/** Adds a link, at the end or before another. Refused (`LinkRefused`) for a value that is not a link's, and past ten. */
export async function addLink(
  deps: TripDeps,
  accountId: string,
  tripId: string,
  input: NewLink,
): Promise<LinkView[] | undefined> {
  const checked = checkLink(input);
  if (!checked.ok) throw new LinkRefused('invalid', checked.sentence);
  const fields = checked.value;
  return change(deps, accountId, tripId, async (tx, seq) => {
    const list = await positionsOf(tx, tripId);
    if (list.length >= MAX_LINKS)
      throw new LinkRefused('limit', `A trip has at most ${MAX_LINKS} links. Remove one first.`);
    const id = randomUUID();
    await dbAll(
      tx,
      sql`INSERT INTO ${tableOf(tx, 'trip_link')} (id, trip_id, kind, position, seq, sealed)
          VALUES (${id}, ${tripId}, ${fields.kind}, ${placeBefore(list, input.before)}, ${seq},
                  ${deps.sealer.seal('trip_link', id, { title: fields.title, url: fields.url })})
          RETURNING id`,
    );
  });
}

export interface LinkPatch {
  readonly kind?: unknown;
  readonly title?: unknown;
  readonly url?: unknown;
}

/** Changes a link's title, address or kind: the fields given change and **the whole is checked as it will be**. */
export async function updateLink(
  deps: TripDeps,
  accountId: string,
  tripId: string,
  linkId: string,
  patch: LinkPatch,
): Promise<LinkView[] | undefined> {
  if (!TRIP_ID.test(linkId)) return undefined;
  if (!('kind' in patch || 'title' in patch || 'url' in patch))
    throw new LinkRefused('invalid', 'There is nothing to change.');
  return change(deps, accountId, tripId, async (tx, seq) => {
    const row = await dbGet<Row>(
      tx,
      sql`SELECT id, kind, position, sealed FROM ${tableOf(tx, 'trip_link')} WHERE id = ${linkId} AND trip_id = ${tripId}`,
    );
    if (!row) throw new NotFound();
    const current = deps.sealer.unseal('trip_link', linkId, bytes(row.sealed));
    const checked = checkLink({
      kind: 'kind' in patch ? patch.kind : row.kind,
      title: 'title' in patch ? patch.title : current.title,
      url: 'url' in patch ? patch.url : current.url,
    });
    if (!checked.ok) throw new LinkRefused('invalid', checked.sentence);
    await dbAll(
      tx,
      sql`UPDATE ${tableOf(tx, 'trip_link')}
          SET kind = ${checked.value.kind}, seq = ${seq},
              sealed = ${deps.sealer.seal('trip_link', linkId, { title: checked.value.title, url: checked.value.url })}
          WHERE id = ${linkId} AND trip_id = ${tripId} RETURNING id`,
    );
  });
}

/** Moves a link to just before another, or to the end. */
export async function moveLink(
  deps: TripDeps,
  accountId: string,
  tripId: string,
  linkId: string,
  before: string | null,
): Promise<LinkView[] | undefined> {
  if (!TRIP_ID.test(linkId)) return undefined;
  return change(deps, accountId, tripId, async (tx, seq) => {
    const list = await positionsOf(tx, tripId, linkId);
    const exists = await dbGet<{ id: string }>(
      tx,
      sql`SELECT id FROM ${tableOf(tx, 'trip_link')} WHERE id = ${linkId} AND trip_id = ${tripId}`,
    );
    if (!exists) throw new NotFound();
    await dbAll(
      tx,
      sql`UPDATE ${tableOf(tx, 'trip_link')} SET position = ${placeBefore(list, before)}, seq = ${seq}
          WHERE id = ${linkId} AND trip_id = ${tripId} RETURNING id`,
    );
  });
}

/** Removes a link. */
export async function removeLink(
  deps: TripDeps,
  accountId: string,
  tripId: string,
  linkId: string,
): Promise<LinkView[] | undefined> {
  if (!TRIP_ID.test(linkId)) return undefined;
  return change(deps, accountId, tripId, async (tx, seq) => {
    const gone = await dbAll<{ id: string }>(
      tx,
      sql`DELETE FROM ${tableOf(tx, 'trip_link')} WHERE id = ${linkId} AND trip_id = ${tripId} RETURNING id`,
    );
    if (gone.length === 0) throw new NotFound();
    await recordGone(tx, tripId, 'trip_link', [linkId], seq, deps.now());
  });
}
