/**
 * What a trip is allowed to be (DESIGN.md §10.1, §11.1), in a file of its own so that the server and, later, the screens use one definition. Pure: nothing here reads a database or a clock. An error names the part that is wrong and
 * never what it was given.
 */
export const ROLES = ['organizer', 'traveler', 'follower'] as const;
export type Role = (typeof ROLES)[number];

/**
 * The colours a trip's dot may be: **the design system's colour roles**, by name, which the screens turn into the token (`--sv-color-accent`, `--sv-color-info-text`, `--sv-color-success-solid`, `--sv-color-warning-text`,
 * `--sv-color-error-solid`, `--sv-color-text-muted`) so that a dot is right in light and dark and under an instance's own accent. The system's identity is monochrome, so these are its roles and not a palette of hues.
 */
export const TRIP_COLORS = ['accent', 'info', 'success', 'warning', 'error', 'neutral'] as const;
export type TripColor = (typeof TRIP_COLORS)[number];
export const DEFAULT_COLOR: TripColor = 'accent';

export const TRIP_NAME_MAX = 120;
export const TRIP_DESCRIPTION_MAX = 2000;
/** A trip's id: a UUID the server makes. */
export const TRIP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A value that is not a trip's. */
export class TripError extends Error {
  override name = 'TripError';
}

/** A name as it is kept: trimmed, one to 120 characters, one line. */
export function cleanTripName(name: unknown): string {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (trimmed === '' || trimmed.length > TRIP_NAME_MAX || /[\r\n]/.test(trimmed))
    throw new TripError(`a trip's name is 1 to ${TRIP_NAME_MAX} characters on one line`);
  return trimmed;
}

/** A description as it is kept: trimmed, up to 2,000 characters, line breaks allowed; nothing at all is no description. */
export function cleanTripDescription(description: unknown): string | undefined {
  if (description === undefined || description === null) return undefined;
  if (typeof description !== 'string')
    throw new TripError(
      `a trip's description is text of at most ${TRIP_DESCRIPTION_MAX} characters`,
    );
  const trimmed = description.trim();
  if (trimmed.length > TRIP_DESCRIPTION_MAX)
    throw new TripError(
      `a trip's description is text of at most ${TRIP_DESCRIPTION_MAX} characters`,
    );
  return trimmed === '' ? undefined : trimmed;
}

export function cleanTripColor(color: unknown): TripColor {
  if (color === undefined || color === null) return DEFAULT_COLOR;
  if (typeof color === 'string' && (TRIP_COLORS as readonly string[]).includes(color))
    return color as TripColor;
  throw new TripError(`a trip's colour is one of ${TRIP_COLORS.join(', ')}`);
}
