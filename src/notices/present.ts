import { localDate } from '../places/tz';

/**
 * How notices read (DESIGN.md §17.1), apart from where they are drawn: how long ago, and the days of the page (the bell's "99+" is the design system's own). **Pure, with the time and the zone given**: nothing here reads a clock,
 * and a notice's day is the day it was in the reader's own zone. `ago` is Tusk's, copied.
 */
export function ago(createdAt: number, now: number, locale?: string): string {
  const seconds = Math.max(0, Math.floor((now - createdAt) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(
    new Date(createdAt),
  );
}

export interface Shown {
  readonly id: string;
  readonly at: number;
}
export interface Day<T extends Shown> {
  /** `YYYY-MM-DD`, in the reader's zone. */
  readonly date: string;
  readonly label: string;
  readonly notices: readonly T[];
}

const previous = (date: string): string => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) - 1)).toISOString().slice(0, 10);
};

/** Notices grouped by the day they were raised in `zone`, "Today", "Yesterday" or the date, newest day first and newest notice first within it. */
export function groupByDay<T extends Shown>(
  notices: readonly T[],
  now: number,
  zone: string,
  locale?: string,
): Day<T>[] {
  const today = localDate(now, zone);
  const yesterday = previous(today);
  const groups = new Map<string, T[]>();
  for (const notice of [...notices].sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1))) {
    const date = localDate(notice.at, zone);
    groups.set(date, [...(groups.get(date) ?? []), notice]);
  }
  return [...groups]
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .map(([date, list]) => {
      const [y, m, d] = date.split('-').map(Number);
      return {
        date,
        label:
          date === today
            ? 'Today'
            : date === yesterday
              ? 'Yesterday'
              : new Intl.DateTimeFormat(locale, {
                  timeZone: 'UTC',
                  weekday: 'short',
                  month: 'short',
                  day: 'numeric',
                  ...(date.slice(0, 4) === today.slice(0, 4) ? {} : { year: 'numeric' }),
                }).format(new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1))),
        notices: list,
      };
    });
}
