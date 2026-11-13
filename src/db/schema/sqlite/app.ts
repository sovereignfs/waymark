import { index, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { bool, counter, epochMs, hhmm, id, isoDate, position, ref, sealed } from './columns';

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

/**
 * Which notices a person wants by which channel (DESIGN.md §17.2, §21): a row for each kind and channel they have **changed**; a kind and channel with no row is at its default (`src/notices/prefs.ts`).
 * `enabled` is 0 or 1 (a whole number, so that a statement means the same on both dialects). Written from Settings only, and removed with the person.
 */
export const noticePref = sqliteTable(
  'notice_pref',
  {
    accountId: ref('account_id').notNull(),
    kind: text('kind').notNull(),
    channel: text('channel').notNull(),
    enabled: counter('enabled').notNull(),
    updatedAt: epochMs('updated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.accountId, table.kind, table.channel] })],
);

/**
 * An import from another service (DESIGN.md §16, §24.3): one row for each file a person uploaded. The file itself is sealed on disk under `/data/imports` (`src/import/files.ts`), named by this row's id.
 * What is plain is what the job and the screen read without opening anything: the owner, the `source` (`swarm`), the `status` (`queued`, `running`, `done`, `failed`, `cancelled`), the `phase` it is in and
 * the `cursor` it has reached in that phase (written after every step, so a restart, a crash or a deploy carries on from it and does nothing twice), the counts shown on the screen, a lease
 * (`claimed_until`, so two workers never work one import) and when it began and ended. **What went wrong is sealed** (`SEALED.import_job`: the errors, each a sentence and a count, never a place or a name).
 */
export const importJob = sqliteTable(
  'import_job',
  {
    id: id('id'),
    accountId: ref('account_id').notNull(),
    source: text('source').notNull(),
    status: text('status').notNull().default('queued'),
    phase: text('phase').notNull().default('checkins'),
    cursor: counter('cursor').notNull().default(0),
    fileBytes: counter('file_bytes').notNull().default(0),
    checkinsDone: counter('checkins_done').notNull().default(0),
    checkinsSkipped: counter('checkins_skipped').notNull().default(0),
    placesMade: counter('places_made').notNull().default(0),
    photosDone: counter('photos_done').notNull().default(0),
    photosFailed: counter('photos_failed').notNull().default(0),
    tripsMade: counter('trips_made').notNull().default(0),
    claimedUntil: epochMs('claimed_until').notNull().default(0),
    sealed: sealed('sealed'),
    createdAt: epochMs('created_at').notNull(),
    updatedAt: epochMs('updated_at').notNull(),
    finishedAt: epochMs('finished_at'),
  },
  (table) => [
    index('import_job_account_idx').on(table.accountId, table.createdAt),
    index('import_job_status_idx').on(table.status, table.claimedUntil),
  ],
);

/**
 * The notices from a Sovereign core that have been acted on (DESIGN.md §19.2): the `jti` of each signed token, kept until it could no longer be accepted, so that **a notice sent twice is acted on once**,
 * by any process and across a restart (the SDK asks `seen` last, of a notice that has met every other rule, so a forged one fills nothing). The first to record a `jti` wins; every later one is a replay. A
 * `jti` is a random id and says nothing of a person. Swept shortly after it expires.
 */
export const noticeSeen = sqliteTable(
  'notice_seen',
  {
    jti: id('jti'),
    expiresAt: epochMs('expires_at').notNull(),
  },
  (table) => [index('notice_seen_expires_idx').on(table.expiresAt)],
);

/**
 * A person's export (DESIGN.md §22, §24.3): one row for each time they asked for their data. A job builds the ZIP (`src/portability/export.ts`) and seals it on disk under `/data/exports`, named by this row's id;
 * the person downloads it from Settings > Data until `expires_at` (a day after it was ready), and then the file is deleted and the row stays a little as a record that it was. Plain: the owner, the `status`
 * (`queued`, `running`, `ready`, `failed`, `expired`), the size, the times and a lease (`claimed_until`, so two workers never build one). Nothing in the row says what is in the file.
 */
export const exportJob = sqliteTable(
  'export_job',
  {
    id: id('id'),
    accountId: ref('account_id').notNull(),
    status: text('status').notNull().default('queued'),
    bytes: counter('bytes').notNull().default(0),
    claimedUntil: epochMs('claimed_until').notNull().default(0),
    createdAt: epochMs('created_at').notNull(),
    readyAt: epochMs('ready_at'),
    expiresAt: epochMs('expires_at'),
  },
  (table) => [
    index('export_job_account_idx').on(table.accountId, table.createdAt),
    index('export_job_status_idx').on(table.status, table.claimedUntil),
  ],
);

/**
 * Where a rotation of the instance key has got to (DESIGN.md §18.1, 3.3): one row for the key being rotated **to** (`fingerprint`, which is a name for a key and never the key), the key it is rotating from, whether
 * it is `running` or `done`, and the place the job has reached (`phase` and `after`, so a stop carries on and does not begin again), with how many envelopes it has moved and how many it could not open (sealed under
 * a key that is in neither of the two). Health reads it to say that a rotation is under way.
 */
export const keyRotation = sqliteTable('key_rotation', {
  fingerprint: id('fingerprint'),
  previousFingerprint: text('previous_fingerprint').notNull(),
  state: text('state').notNull().default('running'),
  phase: text('phase').notNull().default(''),
  after: text('after').notNull().default(''),
  rewrapped: counter('rewrapped').notNull().default(0),
  unopenable: counter('unopenable').notNull().default(0),
  startedAt: epochMs('started_at').notNull(),
  updatedAt: epochMs('updated_at').notNull(),
  finishedAt: epochMs('finished_at'),
});

/**
 * **A person's refresh token at a Sovereign core** (DESIGN.md §19.3), kept so that the app can call core's directory as them. It is a credential: **sealed** (`SEALED.core_token`) and never anywhere else, and the one
 * place the sign-in store's own copy is cleared into at sign-in (`src/sovereign/tokens.ts`). Core rotates it on every use and takes one used twice for theft, so a write is a conditional update on `token_hash` (a hash
 * of the token that was read: the token itself is never in a `WHERE`), and `lock_until` is a lease so that two processes never refresh at once. One row for each `sub`; removed with the account.
 */
export const coreToken = sqliteTable(
  'core_token',
  {
    sub: text('sub').primaryKey(),
    accountId: ref('account_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    lockUntil: epochMs('lock_until').notNull().default(0),
    sealed: sealed('sealed').notNull(),
    updatedAt: epochMs('updated_at').notNull(),
  },
  (table) => [index('core_token_account_idx').on(table.accountId)],
);

/**
 * Calls to a Sovereign core waiting to be made (DESIGN.md §17.2, §19.4): a notice for core's bell, an email by core, a line on the person's activity page. Written **in the transaction of the change that causes it**
 * and made in the background by a job (`src/sovereign/outbox.ts`), so a slow or absent core never holds a request, nothing is held across a call to core, and a call that fails is tried again. The same shape as the
 * mail outbox: a lease (`claimed_until`) so that two workers never make one call, the time of the next try, how many have been made. **What it says is sealed** (`SEALED.core_outbox`); who it is for is the account
 * (`account_id`, from which the job finds their `sub`), or null for a line about someone whose account is gone (its content then names the `sub`).
 */
export const coreOutbox = sqliteTable(
  'core_outbox',
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
    index('core_outbox_due_idx').on(table.nextAttemptAt),
    index('core_outbox_account_idx').on(table.accountId),
  ],
);

/**
 * A trip (DESIGN.md §10.1, §24.3), phase 2. **Its name and description are sealed** (`SEALED.trip`); what is plain is what the database orders and finds by: the colour (one of the design system's accent tokens, `src/trips/format.ts`),
 * the dates (derived from the trip's stops by 9.2, in the same transaction as the change that moves them, and cached here so that lists sort without joining: both null until it has a stop), `ready_at` (the Organizers'
 * decision, 9.4; **status is computed and never stored**), the cover place (9.2), `created_by` (cleared when its creator's account goes, so nothing points at them) and `seq`, the counter of the trip's own stream
 * (15.3), increased by every change to the trip and stamped on the rows it changes. Written only by `src/trips/`; **every statement that reads or writes a trip names the caller's membership and role** (`src/access/trip.ts`).
 */
export const trip = sqliteTable(
  'trip',
  {
    id: id('id'),
    color: text('color').notNull(),
    startDate: isoDate('start_date'),
    endDate: isoDate('end_date'),
    readyAt: epochMs('ready_at'),
    coverPlaceId: ref('cover_place_id'),
    seq: counter('seq').notNull().default(0),
    // The highest number of a trip tombstone that was pruned (`src/sync/history.ts`): a device behind it is given the trip's snapshot again.
    floor: counter('floor').notNull().default(0),
    createdBy: ref('created_by'),
    sealed: sealed('sealed').notNull(),
    createdAt: epochMs('created_at').notNull(),
    updatedAt: epochMs('updated_at').notNull(),
  },
  (table) => [index('trip_dates_idx').on(table.startDate, table.id)],
);

/**
 * A person's part in a trip (DESIGN.md §10.1, §11.1, §24.3): the role (`organizer`, `traveler` or `follower`), whether they are going (an Organizer who only organizes is not), how their check-ins are shared with the
 * trip (`ask`, `on`, `off`, 10.3), who added them and when they joined, and `left_at` once they have left or been removed (the row stays, so the trip can still say who was there; every statement asks for
 * `left_at IS NULL`). Plain throughout: a role and a date say nothing of where anyone was. **The permission to do anything on a trip is this row**, named in the statement that does it.
 */
export const tripMember = sqliteTable(
  'trip_member',
  {
    tripId: ref('trip_id').notNull(),
    accountId: ref('account_id').notNull(),
    role: text('role').notNull(),
    going: bool('going').notNull().default(true),
    shareCheckins: text('share_checkins').notNull().default('ask'),
    addedBy: ref('added_by'),
    joinedAt: epochMs('joined_at').notNull(),
    leftAt: epochMs('left_at'),
    seq: counter('seq').notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.tripId, table.accountId] }),
    index('trip_member_account_idx').on(table.accountId),
  ],
);

/**
 * A stop of a trip (DESIGN.md §10.3, §24.3): **a place of the trip's** (`place_id`, a `place` row with this `trip_id`), an arrival and a departure (`YYYY-MM-DD` in the place's zone, both or neither: a stop may have no dates while
 * the trip is being planned), an order (`position`, which orders the undated ones; dated ones are in the order of their dates) and **a note, sealed** (`SEALED.stop`). `version` counts changes and `seq` is the trip's stream counter at
 * the change (15.3). Written only by `src/trips/plan.ts`, whose every statement names the caller's membership and role; the trip's own dates are recomputed from its stops in the same transaction.
 */
export const stop = sqliteTable(
  'stop',
  {
    id: id('id'),
    tripId: ref('trip_id').notNull(),
    placeId: ref('place_id').notNull(),
    arrive: isoDate('arrive'),
    depart: isoDate('depart'),
    position: position('position').notNull(),
    version: counter('version').notNull().default(1),
    seq: counter('seq').notNull().default(0),
    sealed: sealed('sealed').notNull(),
    createdAt: epochMs('created_at').notNull(),
    updatedAt: epochMs('updated_at').notNull(),
  },
  (table) => [
    index('stop_trip_idx').on(table.tripId, table.seq),
    index('stop_place_idx').on(table.placeId),
  ],
);

/**
 * A day of a stop (DESIGN.md §10.4, §24.3): one for each date from the stop's arrival to its departure, **made and removed with those dates** (a day with items is never removed silently). **A travel day shared by two stops is
 * two days, one in each.** Its title and notes are sealed (`SEALED.day`) and are set by the offline edit of 6.6.
 */
export const day = sqliteTable(
  'day',
  {
    id: id('id'),
    tripId: ref('trip_id').notNull(),
    stopId: ref('stop_id').notNull(),
    date: isoDate('date').notNull(),
    version: counter('version').notNull().default(1),
    seq: counter('seq').notNull().default(0),
    sealed: sealed('sealed').notNull(),
  },
  (table) => [
    index('day_trip_idx').on(table.tripId, table.seq),
    uniqueIndex('day_stop_date_idx').on(table.stopId, table.date),
  ],
);

/**
 * An item (DESIGN.md §10.5, §24.3): something planned on a day, **a place of the trip's (`place_id`) or a title, or both**. The kind (`sight`, `food`, `stay`, `transport`, `activity`, `other`), the start and end times (`HH:mm`, in the
 * stop's zone, which is why they are plain: no zone is in them) and whether it is **fixed** (a commitment, which needs a start) are plain; **the title and the notes are sealed** (`SEALED.item`). `position` is the day's order as dragged (a
 * fractional position, independent of times). `created_by` and `updated_by` are the accounts that made and last changed it, cleared when an account is deleted so that nothing points at them; `version` and `seq` as everywhere. Written
 * only by `src/trips/plan.ts`. (The design's `start` and `end` are `start_time` and `end_time` here: both are reserved words in SQL.)
 */
export const item = sqliteTable(
  'item',
  {
    id: id('id'),
    tripId: ref('trip_id').notNull(),
    dayId: ref('day_id').notNull(),
    placeId: ref('place_id'),
    kind: text('kind').notNull().default('other'),
    startTime: hhmm('start_time'),
    endTime: hhmm('end_time'),
    fixed: bool('fixed').notNull().default(false),
    position: position('position').notNull(),
    version: counter('version').notNull().default(1),
    seq: counter('seq').notNull().default(0),
    createdBy: ref('created_by'),
    updatedBy: ref('updated_by'),
    sealed: sealed('sealed').notNull(),
    createdAt: epochMs('created_at').notNull(),
    updatedAt: epochMs('updated_at').notNull(),
  },
  (table) => [
    index('item_trip_idx').on(table.tripId, table.seq),
    index('item_day_idx').on(table.dayId, table.position),
    index('item_place_idx').on(table.placeId),
  ],
);

/**
 * An attachment of a trip (DESIGN.md §10.6, §24.3): a receipt, a booking, an accommodation record, a ticket or something else, **a file** (`media_id`, a `media` row owned by the trip, and `thumb_id` for an image's thumbnail) on the trip
 * or on one day. **Its title is sealed** (`SEALED.attachment`); the file is sealed on disk. **Seen and added by Organizers and Travelers, never by Followers** (DESIGN.md §11.1): every statement that reads or writes one names
 * `ATTACHMENT_READERS` (`src/access/trip.ts`), so for a Follower the row, the file and the thumbnail are not there. `seq` is the trip's counter at the last change to it (a rename advances it). `created_by` is cleared when the
 * account is deleted, and the attachment stays, as the trip's. Written only by `src/trips/attachments.ts`.
 */
export const attachment = sqliteTable(
  'attachment',
  {
    id: id('id'),
    tripId: ref('trip_id').notNull(),
    dayId: ref('day_id'),
    kind: text('kind').notNull().default('other'),
    mediaId: ref('media_id').notNull(),
    thumbId: ref('thumb_id'),
    seq: counter('seq').notNull().default(0),
    createdBy: ref('created_by'),
    sealed: sealed('sealed').notNull(),
    createdAt: epochMs('created_at').notNull(),
  },
  (table) => [
    index('attachment_trip_idx').on(table.tripId, table.seq),
    index('attachment_day_idx').on(table.dayId),
    uniqueIndex('attachment_media_idx').on(table.mediaId),
  ],
);

/**
 * A link of a trip (DESIGN.md §10.7, §24.3): up to ten, each **a title and an `https` address, both sealed** (`SEALED.trip_link`: an address can carry a token in its path or query, and a title says what a trip is for). The `kind` is
 * `tally` when it was chosen as _Expenses in Tally_ and `other` otherwise: Waymark knows nothing of Tally beyond that choice and the address. `position` is the order they were put in. **Waymark never fetches a link, shows no preview**
 * and makes no request to its address; a person's own browser opens it when they choose to. Read by every member, Followers included, and edited by Organizers and Travelers (`src/trips/links.ts`).
 */
export const tripLink = sqliteTable(
  'trip_link',
  {
    id: id('id'),
    tripId: ref('trip_id').notNull(),
    kind: text('kind').notNull().default('other'),
    position: position('position').notNull(),
    seq: counter('seq').notNull().default(0),
    sealed: sealed('sealed').notNull(),
  },
  (table) => [index('trip_link_trip_idx').on(table.tripId, table.position)],
);

/**
 * Trips whose check-ins must be linked again (DESIGN.md §12): a row is made, **in the transaction that changed the trip's stops' dates** (or who goes on it), and a job (`src/autolink/queue.ts`) re-decides the automatic links of
 * the people it concerns, a batch at a time, and then deletes the row. A lease (`claimed_until`) so that two workers or two processes never work one, and the row is kept if the trip was asked for again meanwhile
 * (`requested_at`), so that nothing is lost; the work is safe to do twice, since a decision made again is the same. Holds only an id and two times: nothing of a person.
 */
export const relink = sqliteTable(
  'relink',
  {
    tripId: id('trip_id'),
    requestedAt: epochMs('requested_at').notNull(),
    claimedUntil: epochMs('claimed_until').notNull().default(0),
  },
  (table) => [index('relink_due_idx').on(table.claimedUntil, table.requestedAt)],
);

/**
 * A check-in shared with a trip (DESIGN.md §11.3, §15.3, §24.3): **the reader's copy**, one for each check-in that is shared and linked, in the trip's stream (`seq` is the trip's counter at the change). The author's own check-in stays in their
 * stream; this is what the other members are given, with the place, moment, note, companions and photos, **sealed** (`SEALED.shared_checkin`). Written only by `src/sharing/copies.ts`, in the transaction of the change that shares, edits, unshares or unlinks
 * the check-in (or that changes the author's part in the trip), and removed with it. Plain: the check-in, the trip and the author, which are what a statement asks about; nothing of where anyone was.
 */
export const sharedCheckin = sqliteTable(
  'shared_checkin',
  {
    checkinId: id('checkin_id'),
    tripId: ref('trip_id').notNull(),
    accountId: ref('account_id').notNull(),
    seq: counter('seq').notNull().default(0),
    sealed: sealed('sealed').notNull(),
  },
  (table) => [
    index('shared_checkin_trip_idx').on(table.tripId, table.seq),
    index('shared_checkin_account_idx').on(table.accountId),
  ],
);

/**
 * What was deleted from a trip's stream (DESIGN.md §15.3): **the trip's counterpart of `tombstone`**. A row of a trip that is deleted (a stop, a day, an item, a trip place, a link, an attachment, a shared check-in's copy, a member's row) leaves its table, its id and the trip's number at the deletion
 * here, **with no content**, so that a device that was away is told. Written in the transaction of the deletion (`src/trips/gone.ts`), taken away when the row is made again under its id, and pruned after 90 days (`src/sync/history.ts`), which raises the trip's `floor`. A deleted *trip* leaves no tombstones: its members are told it is gone.
 */
export const tripTombstone = sqliteTable(
  'trip_tombstone',
  {
    tripId: ref('trip_id').notNull(),
    tableName: text('table_name').notNull(),
    rowId: ref('row_id').notNull(),
    seq: counter('seq').notNull(),
    deletedAt: epochMs('deleted_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tripId, table.tableName, table.rowId] }),
    index('trip_tombstone_seq_idx').on(table.tripId, table.seq),
  ],
);

/**
 * A person's _Done_ mark on an item (DESIGN.md §14.1): "I did this" without checking in, **theirs alone** (`account_id`), in the trip's stream and read by nobody else. Made and taken away by the person's own mutation in the trip's stream
 * (`src/trips/sync.ts`), by an Organizer or a Traveler; a mark of an item that was deleted is not shown (the pull joins to the item) and goes with the trip, with the person (`People.deletePerson`) and when they leave. Holds nothing but the
 * three ids and a time: nothing sealed.
 */
export const itemDone = sqliteTable(
  'item_done',
  {
    tripId: ref('trip_id').notNull(),
    itemId: ref('item_id').notNull(),
    accountId: ref('account_id').notNull(),
    doneAt: epochMs('done_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tripId, table.itemId, table.accountId] }),
    index('item_done_account_idx').on(table.accountId),
  ],
);

/**
 * A device that can be told by Web Push (DESIGN.md §17.3, §24.3): one row for each browser a person turned push on in. **The push service's address and the keys that encrypt to this device are sealed** (`SEALED.push_subscription`); what
 * the database may know is the owner and a hash of the address (so that turning it on again in the same browser is one row, not two). Removed when the push service says the device is gone, when the person turns it off, and with the person.
 */
export const pushSubscription = sqliteTable(
  'push_subscription',
  {
    id: id('id'),
    accountId: ref('account_id').notNull(),
    endpointHash: text('endpoint_hash').notNull(),
    lastOkAt: epochMs('last_ok_at'),
    sealed: sealed('sealed').notNull(),
    createdAt: epochMs('created_at').notNull(),
    updatedAt: epochMs('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('push_subscription_endpoint_idx').on(table.accountId, table.endpointHash),
    index('push_subscription_account_idx').on(table.accountId),
  ],
);

/**
 * Pushes waiting to be sent (DESIGN.md §17.3): one row for each notice and device, **written in the transaction of the change that raised the notice** and sent by a job that claims it by a lease, as mail is. It holds the kind of notice and
 * the path it opens, which is all a push says (the push service carries it, so no place, note or name is in it), and is deleted when it is sent, when the device is gone, and when it is given up on (`expires_at`: a reminder an hour late is no reminder).
 */
export const pushOutbox = sqliteTable(
  'push_outbox',
  {
    id: id('id'),
    subscriptionId: ref('subscription_id').notNull(),
    accountId: ref('account_id').notNull(),
    kind: text('kind').notNull(),
    path: text('path').notNull(),
    attempts: counter('attempts').notNull().default(0),
    nextAttemptAt: epochMs('next_attempt_at').notNull(),
    claimedUntil: epochMs('claimed_until').notNull().default(0),
    expiresAt: epochMs('expires_at').notNull(),
    createdAt: epochMs('created_at').notNull(),
  },
  (table) => [
    index('push_outbox_due_idx').on(table.nextAttemptAt),
    index('push_outbox_subscription_idx').on(table.subscriptionId),
    index('push_outbox_account_idx').on(table.accountId),
  ],
);

/**
 * A member's settings for a trip's reminders (DESIGN.md §14.4): **theirs, for this trip** (the channels per kind are in Settings, `notice_pref`). A row only when they changed something; without one the defaults are `trip_starts` on,
 * `item_soon` on for fixed items, 30 minutes before, and `day_plan` off. Made and changed by the member alone; removed with the trip, when they leave it and with their account.
 */
export const reminderPref = sqliteTable(
  'reminder_pref',
  {
    tripId: ref('trip_id').notNull(),
    accountId: ref('account_id').notNull(),
    tripStarts: bool('trip_starts').notNull().default(true),
    itemSoon: bool('item_soon').notNull().default(true),
    leadMin: counter('lead_min').notNull().default(30),
    flexible: bool('flexible').notNull().default(false),
    dayPlan: bool('day_plan').notNull().default(false),
    updatedAt: epochMs('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tripId, table.accountId] }),
    index('reminder_pref_account_idx').on(table.accountId),
  ],
);

/**
 * A reminder that was sent (DESIGN.md §14.4): **once for each person and `key`**, which names what it was about (the trip, a day, an item **and the time it was at**, so an item moved to a new time can remind again). The key is written
 * in the same transaction as the notice and decides, by its primary key, which of two workers sends it. Kept a month for that, then pruned. Nothing in it says where anyone was.
 */
export const reminderSent = sqliteTable(
  'reminder_sent',
  {
    tripId: ref('trip_id').notNull(),
    accountId: ref('account_id').notNull(),
    key: text('key').notNull(),
    sentAt: epochMs('sent_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tripId, table.accountId, table.key] }),
    index('reminder_sent_at_idx').on(table.sentAt),
  ],
);

/**
 * An invitation to a trip (DESIGN.md §11.2, §24.3): **one trip, one role**, made by an Organizer. Its token is 32 random bytes shown once (in the link) and **kept only as its hash** (`token_hash`), compared in constant time; it is valid 14 days
 * (`expires_at`), **single-use** (`accepted_at`) and revocable (`revoked_at`). It is for a person the Organizer shares a trip with (`target_account_id`, told by a notice), for an email address (the address is sealed, `SEALED.invitation`), or
 * for nobody in particular (a link): whoever holds the link can accept it, once. Removed with the trip and with the people it names.
 */
export const invitation = sqliteTable(
  'invitation',
  {
    id: id('id'),
    tripId: ref('trip_id').notNull(),
    role: text('role').notNull(),
    via: text('via').notNull(),
    invitedBy: ref('invited_by'),
    targetAccountId: ref('target_account_id'),
    // The person a core's directory named, by their `sub`, when they have no account here yet: their first sign-in through that core takes the invitation (`src/invitations/`, DESIGN.md §11.2).
    targetSub: text('target_sub'),
    tokenHash: text('token_hash').notNull(),
    lastSentAt: epochMs('last_sent_at').notNull(),
    expiresAt: epochMs('expires_at').notNull(),
    acceptedBy: ref('accepted_by'),
    acceptedAt: epochMs('accepted_at'),
    revokedAt: epochMs('revoked_at'),
    sealed: sealed('sealed').notNull(),
    createdAt: epochMs('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('invitation_token_idx').on(table.tokenHash),
    index('invitation_trip_idx').on(table.tripId),
    index('invitation_invited_by_idx').on(table.invitedBy),
    index('invitation_target_idx').on(table.targetAccountId),
    index('invitation_target_sub_idx').on(table.targetSub),
  ],
);
