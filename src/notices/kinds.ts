/**
 * The kinds of notice there are (DESIGN.md §17.1), in a file of their own so that the notices and the preferences about them can both name them. Phase 1 has one, and phase 2 adds `organizer_passed` (9.1), `trip_ready` and `trip_dates` (9.4), `role_changed` (10.1), `checkin_shared` (10.3); the rest of phases 2 and 3 are added by the
 * tasks that raise them, here, with the sentence a person reads for each in `prefs.ts`.
 */
export const KINDS = [
  'import_finished',
  'organizer_passed',
  'trip_ready',
  'trip_dates',
  'role_changed',
  'checkin_shared',
] as const;
export type NoticeKind = (typeof KINDS)[number];
