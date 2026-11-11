import { index, pgSchema, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { APP_STORE } from '../../config';
import { bool, counter, epochMs, hhmm, id, isoDate, position, ref, sealed } from './columns';

/** The app's schema; better-auth's is `waymark_auth` (DESIGN.md §24.1). */
export const app = pgSchema(APP_STORE);

/** See `schema/sqlite/app.ts`. */
export const rateBucket = app.table(
  'rate_bucket',
  {
    key: id('key'),
    windowStart: epochMs('window_start').notNull(),
    count: counter('count').notNull(),
  },
  (table) => [index('rate_bucket_window_idx').on(table.windowStart)],
);

/** See `schema/sqlite/app.ts`. */
export const jobClaim = app.table('job_claim', {
  job: id('job'),
  claimedUntil: epochMs('claimed_until').notNull(),
});

/** See `schema/sqlite/app.ts`. */
export const profile = app.table('profile', {
  accountId: ref('account_id').primaryKey(),
  coreSub: ref('core_sub'),
  units: text('units').notNull().default('km'),
  weekStart: counter('week_start').notNull().default(1),
  shareDefault: text('share_default').notNull().default('ask'),
  sealed: sealed('sealed').notNull(),
  createdAt: epochMs('created_at').notNull(),
  updatedAt: epochMs('updated_at').notNull(),
});

/** See `schema/sqlite/app.ts`. */
export const media = app.table(
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

/** See `schema/sqlite/app.ts`. */
export const place = app.table(
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

/** See `schema/sqlite/app.ts`. */
export const checkin = app.table(
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

/** See `schema/sqlite/app.ts`. */
export const accountStream = app.table('account_stream', {
  accountId: ref('account_id').primaryKey(),
  seq: counter('seq').notNull().default(0),
  // The highest number of a tombstone that was pruned (`src/sync/history.ts`): a device that has not heard of the stream since before it is given a fresh snapshot, since it may have missed a delete.
  floor: counter('floor').notNull().default(0),
});

/** See `schema/sqlite/app.ts`. */
export const appliedMutation = app.table(
  'applied_mutation',
  {
    accountId: ref('account_id').notNull(),
    mutationId: ref('mutation_id').notNull(),
    seq: counter('seq').notNull(),
    appliedAt: epochMs('applied_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.accountId, table.mutationId] })],
);

/** See `schema/sqlite/app.ts`. */
export const tombstone = app.table(
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

/** See `schema/sqlite/app.ts`. */
export const checkinPhoto = app.table(
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

/** See `schema/sqlite/app.ts`. */
export const notice = app.table(
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

/** See `schema/sqlite/app.ts`. */
export const mailOutbox = app.table(
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

/** See `schema/sqlite/app.ts`. */
export const noticePref = app.table(
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

/** See `schema/sqlite/app.ts`. */
export const importJob = app.table(
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

/** See `schema/sqlite/app.ts`. */
export const noticeSeen = app.table(
  'notice_seen',
  {
    jti: id('jti'),
    expiresAt: epochMs('expires_at').notNull(),
  },
  (table) => [index('notice_seen_expires_idx').on(table.expiresAt)],
);

/** See `schema/sqlite/app.ts`. */
export const exportJob = app.table(
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

/** See `schema/sqlite/app.ts`. */
export const keyRotation = app.table('key_rotation', {
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

/** See `schema/sqlite/app.ts`. */
export const coreOutbox = app.table(
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

/** See `schema/sqlite/app.ts`. */
export const trip = app.table(
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

/** See `schema/sqlite/app.ts`. */
export const tripMember = app.table(
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

/** See `schema/sqlite/app.ts`. */
export const stop = app.table(
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

/** See `schema/sqlite/app.ts`. */
export const day = app.table(
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

/** See `schema/sqlite/app.ts`. */
export const item = app.table(
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

/** See `schema/sqlite/app.ts`. */
export const attachment = app.table(
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

/** See `schema/sqlite/app.ts`. */
export const tripLink = app.table(
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

/** See `schema/sqlite/app.ts`. */
export const relink = app.table(
  'relink',
  {
    tripId: id('trip_id'),
    requestedAt: epochMs('requested_at').notNull(),
    claimedUntil: epochMs('claimed_until').notNull().default(0),
  },
  (table) => [index('relink_due_idx').on(table.claimedUntil, table.requestedAt)],
);

/** See `schema/sqlite/app.ts`. */
export const sharedCheckin = app.table(
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

/** See `schema/sqlite/app.ts`. */
export const tripTombstone = app.table(
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
