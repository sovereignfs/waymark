'use client';

import { Button, FormField, Input, Select } from '@sovereignfs/ui';
import styles from './Timeline.module.css';
import { type Filters, isFiltered } from './timeline';

/**
 * The filters of the timeline and of the map (DESIGN.md §20.6, §20.7): a search, a year, a category, a country and, where the device holds a trip, a trip. **They are the address's**: the caller changes the query (`set`) and
 * reads it back (`parseFilters`), so the same filters mean the same on both screens and in a link.
 */
export function FilterBar({
  filters,
  options,
  trips,
  set,
  clear,
}: {
  filters: Filters;
  options: { years: number[]; categories: string[]; countries: string[] };
  trips: readonly { id: string; name: string }[];
  set: (patch: Record<string, string | undefined>) => void;
  clear: () => void;
}) {
  return (
    <div className={styles.filters} role="search" aria-label="Filter check-ins">
      <FormField label="Search" className={styles.search}>
        {(field) => (
          <Input
            {...field}
            type="search"
            name="q"
            autoComplete="off"
            placeholder="Places and notes"
            value={filters.q}
            onChange={(event) => set({ q: event.target.value })}
          />
        )}
      </FormField>
      <FormField label="Year">
        {(field) => (
          <Select
            {...field}
            name="year"
            value={filters.year ? String(filters.year) : ''}
            onChange={(event) => set({ year: event.target.value })}
          >
            <option value="">All</option>
            {options.years.map((year) => (
              <option key={year} value={year}>
                {year}
              </option>
            ))}
          </Select>
        )}
      </FormField>
      <FormField label="Category">
        {(field) => (
          <Select
            {...field}
            name="category"
            value={filters.category ?? ''}
            onChange={(event) => set({ category: event.target.value })}
          >
            <option value="">All</option>
            {options.categories.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </Select>
        )}
      </FormField>
      <FormField label="Country">
        {(field) => (
          <Select
            {...field}
            name="country"
            value={filters.country ?? ''}
            onChange={(event) => set({ country: event.target.value })}
          >
            <option value="">All</option>
            {options.countries.map((country) => (
              <option key={country} value={country}>
                {country}
              </option>
            ))}
          </Select>
        )}
      </FormField>
      {trips.length > 0 ? (
        <FormField label="Trip">
          {(field) => (
            <Select
              {...field}
              name="trip"
              value={filters.trip ?? ''}
              onChange={(event) => set({ trip: event.target.value })}
            >
              <option value="">All</option>
              {trips.map((trip) => (
                <option key={trip.id} value={trip.id}>
                  {trip.name}
                </option>
              ))}
            </Select>
          )}
        </FormField>
      ) : null}
      {isFiltered(filters) ? (
        <Button type="button" variant="secondary" onClick={clear}>
          Clear
        </Button>
      ) : null}
    </div>
  );
}
