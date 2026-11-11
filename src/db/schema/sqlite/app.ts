import { index, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { counter, epochMs, id, ref, sealed } from './columns';

/**
 * What the server holds that is not better-auth's (DESIGN.md §24.3). The account itself is better-auth's, in the other store, so an `account_id` is a
 * reference by value and not a foreign key. The tables of later tasks are added by their own migrations, one `pnpm db:generate` each.
 */

/**
 * Counts for rate limits, in the database so that a limit holds across every process: a key, when its window began, and how many have been counted
 * in it (`src/limits/rate.ts`). Swept when a window is long over. No key is a person's name or address in the clear: a caller hashes what it keys by.
 */
export const rateBucket = sqliteTable(
  'rate_bucket',
  {
    key: id('key'),
    windowStart: epochMs('window_start').notNull(),
    count: counter('count').notNull(),
  },
  (table) => [index('rate_bucket_window_idx').on(table.windowStart)],
);

/**
 * A lease on a job that has no row of its own to claim (`src/jobs/claim.ts`, `claimJob`): a periodic sweep, say. A process takes the lease by one
 * conditional statement, and only the one that did runs the job until `claimed_until`. A job with rows (an import, a mail in the outbox) claims the row.
 */
export const jobClaim = sqliteTable('job_claim', {
  job: id('job'),
  claimedUntil: epochMs('claimed_until').notNull(),
});

/**
 * Waymark's own copy of an account's name and email, made with the account and kept in step from Settings (DESIGN.md §6.1), as Tally keeps `person`. The account is
 * better-auth's, in the other store, so `account_id` is a reference by value. **The name and the email are sealed** (`SEALED.profile`); what is plain is what the
 * app reads without them: the account's identity at core (`core_sub`, an opaque id and not a name), and a person's choices (`units`, `km` or `mi`; `week_start`, 0
 * for Sunday to 6; `share_default`, `ask`, `on` or `off`, DESIGN.md §11.3).
 */
export const profile = sqliteTable('profile', {
  accountId: ref('account_id').primaryKey(),
  coreSub: ref('core_sub'),
  units: text('units').notNull().default('km'),
  weekStart: counter('week_start').notNull().default(1),
  shareDefault: text('share_default').notNull().default('ask'),
  sealed: sealed('sealed').notNull(),
  createdAt: epochMs('created_at').notNull(),
  updatedAt: epochMs('updated_at').notNull(),
});

/**
 * A file's row (DESIGN.md §18.3, §24.3): a photo, its thumbnail, an attachment or an uploaded import. **The file is under `/data/media`, named by this id, sealed with a data key
 * of its own**; the row holds only what the database must count and join by: the owner (`account_id`, or `trip_id` for a trip's file, exactly one), the `kind`, the stored `type`,
 * the `bytes` stored, and whether the file is `ready` (written) or still `pending` (a row made before its file, which a sweep removes if the file never comes). A file is read only
 * through `/api/media/<id>` after the access check.
 */
export const media = sqliteTable(
  'media',
  {
    id: id('id'),
    accountId: ref('account_id'),
    tripId: ref('trip_id'),
    kind: text('kind').notNull(),
    type: text('type').notNull(),
    bytes: counter('bytes').notNull(),
    state: text('state').notNull().default('pending'),
    createdAt: epochMs('created_at').notNull(),
  },
  (table) => [
    index('media_account_idx').on(table.accountId),
    index('media_trip_idx').on(table.tripId),
  ],
);

/**
 * A place (DESIGN.md §7.1, §24.3): a person's, or a trip's, **exactly one of `account_id` and `trip_id`** (`src/places/places.ts` writes it so, and a trip's arrive with 9.2). **What says
 * where or what is sealed** (`SEALED.place`): the name, the point, the address in parts, the category and the source's id. What is plain is what the database must read: the owner,
 * the `source` (`manual`, `osm` or `import`), the time zone and the country code (found from the point, §7.3, and a default a person can correct), a `version` that counts changes,
 * and the stream's `seq` (assigned by the one write path of sync, 6.1; 0 until a change goes through it). No sealed field is a column, in a `WHERE`, an `ORDER BY` or an index: a
 * search, a distance and a figure are worked out in memory on opened rows.
 */
export const place = sqliteTable(
  'place',
  {
    id: id('id'),
    accountId: ref('account_id'),
    tripId: ref('trip_id'),
    source: text('source').notNull().default('manual'),
    tz: text('tz'),
    countryCode: text('country_code'),
    version: counter('version').notNull().default(1),
    seq: counter('seq').notNull().default(0),
    // 0 for a place with a name; 1 or more for one made from a point alone that is waiting to be named by reverse lookup (the number of tries made, plus one).
    unnamed: counter('unnamed').notNull().default(0),
    sealed: sealed('sealed').notNull(),
    createdAt: epochMs('created_at').notNull(),
    updatedAt: epochMs('updated_at').notNull(),
  },
  (table) => [
    index('place_account_idx').on(table.accountId, table.seq),
    index('place_trip_idx').on(table.tripId, table.seq),
  ],
);

/**
 * A check-in (DESIGN.md §9.1, §24.3): **its author's, and nobody else's**. What is plain is what the database orders and finds by: the owner, the place it names (`place_id`), the moment `at`
 * with its zone and the offset then, the trip link (`trip_id`, and `link_source`, `auto` or `manual`), who it is shared with, how it was made and the import's own id (unique for an account, so
 * importing again adds nothing twice), a `version` that counts changes and the stream's `seq`. **What was written and who was with the person is sealed** (`SEALED.checkin`: the note and the
 * companions). Written only by `src/sync/apply.ts`.
 */
export const checkin = sqliteTable(
  'checkin',
  {
    id: id('id'),
    accountId: ref('account_id').notNull(),
    placeId: ref('place_id').notNull(),
    at: epochMs('at').notNull(),
    tz: text('tz').notNull(),
    offsetMin: counter('offset_min').notNull(),
    tripId: ref('trip_id'),
    linkSource: text('link_source'),
    share: text('share').notNull().default('trip'),
    source: text('source').notNull().default('live'),
    externalId: text('external_id'),
    version: counter('version').notNull().default(1),
    seq: counter('seq').notNull().default(0),
    sealed: sealed('sealed').notNull(),
    createdAt: epochMs('created_at').notNull(),
    updatedAt: epochMs('updated_at').notNull(),
  },
  (table) => [
    index('checkin_account_at_idx').on(table.accountId, table.at),
    index('checkin_account_seq_idx').on(table.accountId, table.seq),
    index('checkin_trip_idx').on(table.tripId),
    index('checkin_place_idx').on(table.placeId),
    uniqueIndex('checkin_external_idx').on(table.accountId, table.externalId),
  ],
);

/**
 * The order of a person's own stream (DESIGN.md §15.3): one counter for each account, increased in the transaction that applies a mutation and stamped on each row it changes, so a device
 * asks for what is past the last number it saw. A row is made with the account's first change.
 */
export const accountStream = sqliteTable('account_stream', {
  accountId: ref('account_id').primaryKey(),
  seq: counter('seq').notNull().default(0),
  // The highest number of a tombstone that was pruned (`src/sync/history.ts`): a device that has not heard of the stream since before it is given a fresh snapshot, since it may have missed a delete.
  floor: counter('floor').notNull().default(0),
});

/**
 * The mutations already applied (DESIGN.md §15.3): a mutation is applied once, and **a replay of one that is here writes nothing**. The key is the account and the id the device made; `seq` is
 * the last number the mutation took. Kept for as long as a device may still send it (`6.7` prunes).
 */
export const appliedMutation = sqliteTable(
  'applied_mutation',
  {
    accountId: ref('account_id').notNull(),
    mutationId: ref('mutation_id').notNull(),
    seq: counter('seq').notNull(),
    appliedAt: epochMs('applied_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.accountId, table.mutationId] })],
);

/**
 * What was deleted from a stream (DESIGN.md §15.3): a deleted row is gone, and a device that has not heard is told by this, **with no content**: the table, the id, and when in the stream. A
 * row made again under the same id (an edit that restores it) takes its tombstone away.
 */
export const tombstone = sqliteTable(
  'tombstone',
  {
    accountId: ref('account_id').notNull(),
    tableName: text('table_name').notNull(),
    rowId: ref('row_id').notNull(),
    seq: counter('seq').notNull(),
    deletedAt: epochMs('deleted_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.tableName, table.rowId] }),
    index('tombstone_account_seq_idx').on(table.accountId, table.seq),
  ],
);

/**
 * The photos of a check-in (DESIGN.md §9.3, §24.3), in order: the row's `id` is the media id the device made for the photo, so a photo is on one check-in at most and moving it is writing it
 * again. The file is a `media` row's and is under `/data/media`; **this row may be made before the file arrives** (a photo taken offline uploads when there is a network), and the check-in shows
 * a placeholder until it does. Written only by `src/sync/apply.ts`, which also removes a photo's files when it leaves a check-in or the check-in is deleted.
 */
export const checkinPhoto = sqliteTable(
  'checkin_photo',
  {
    id: id('id'),
    checkinId: ref('checkin_id').notNull(),
    accountId: ref('account_id').notNull(),
    position: counter('position').notNull(),
    seq: counter('seq').notNull().default(0),
  },
  (table) => [
    index('checkin_photo_checkin_idx').on(table.checkinId, table.position),
    index('checkin_photo_account_idx').on(table.accountId),
  ],
);

/**
 * A notice (DESIGN.md §17.1, §24.3): one row for each person told, **raised in the transaction of the change that caused it and never for the person who made the change**
 * (`src/notices/notices.ts`). What is plain is what the database orders and counts by: the person told, the `kind`, when (`created_at`), whether it was read (`read_at`, null while
 * unread) and the trip it is about, for the kinds of phase 2 (a notice about a trip the person left is not shown). **What it says is sealed** (`SEALED.notice`): its title, its detail and
 * where it opens. Kept 90 days and at most 500 a person (a job prunes).
 */
export const notice = sqliteTable(
  'notice',
  {
    id: id('id'),
    accountId: ref('account_id').notNull(),
    kind: text('kind').notNull(),
    tripId: ref('trip_id'),
    readAt: epochMs('read_at'),
    sealed: sealed('sealed').notNull(),
    createdAt: epochMs('created_at').notNull(),
  },
  (table) => [index('notice_account_idx').on(table.accountId, table.createdAt)],
);

/**
 * Mail waiting to be sent (DESIGN.md §17.2, §24.3), written in the transaction of the change that causes it and sent in the background by a job (`src/mail/outbox.ts`), so a slow or
 * absent mail server never holds a request. **The address and the message are sealed** (`SEALED.mail_outbox`); what is plain is what the job claims by: when to try next
 * (`next_attempt_at`), a lease (`claimed_until`, so two workers never send one message), how many tries have been made, and the person it is for (`account_id`, null for mail to someone who has no
 * account yet: a verification link). A row is deleted when it is sent, and when it is given up on.
 */
export const mailOutbox = sqliteTable(
  'mail_outbox',
  {
    id: id('id'),
    accountId: ref('account_id'),
    kind: text('kind').notNull(),
    attempts: counter('attempts').notNull().default(0),
    nextAttemptAt: epochMs('next_attempt_at').notNull(),
    claimedUntil: epochMs('claimed_until').notNull().default(0),
    sealed: sealed('sealed').notNull(),
    createdAt: epochMs('created_at').notNull(),
  },
  (table) => [
    index('mail_outbox_due_idx').on(table.nextAttemptAt),
    index('mail_outbox_account_idx').on(table.accountId),
  ],
);
