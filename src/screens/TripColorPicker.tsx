'use client';

import { TRIP_COLORS, type TripColor } from '../trips/format';
import styles from './Trips.module.css';
import { DOT } from './trips';

/** The six colour roles a trip's dot can have, as one choice among radios (DESIGN.md §20.9): the same in _New trip_ and in the trip's menu. */
export const COLOR_NAME: Readonly<Record<TripColor, string>> = {
  accent: 'Accent',
  info: 'Blue',
  success: 'Green',
  warning: 'Amber',
  error: 'Red',
  neutral: 'Grey',
};

export function TripColorPicker({
  value,
  onChange,
}: {
  value: TripColor;
  onChange: (color: TripColor) => void;
}) {
  return (
    <div role="radiogroup" aria-label="Colour">
      <ul className={styles.swatches}>
        {TRIP_COLORS.map((each) => (
          <li key={each}>
            <button
              type="button"
              role="radio"
              aria-checked={value === each}
              aria-label={COLOR_NAME[each]}
              title={COLOR_NAME[each]}
              className={styles.swatch}
              onClick={() => onChange(each)}
            >
              <span className={styles.dot} style={{ background: DOT[each] }} aria-hidden />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
