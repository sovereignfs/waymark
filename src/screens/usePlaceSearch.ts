'use client';

import { useEffect, useState } from 'react';
import type { Candidate } from '../places/providers';
import type { Position } from './checkin-flow';

/**
 * The place search from the sheet (DESIGN.md §7.2, §9.2): what the server's `/api/places` finds for what is typed, **after a pause and for three characters or more**, and what is at the position by reverse lookup.
 * The browser asks this server and no other. The position is **not sent with a search**, only with a reverse lookup, which is a question about that point. With no connection, with no place search on the server or with
 * one that is not reachable, **it says so and the person's own places are still there** (`status`).
 */
export type SearchStatus = 'idle' | 'loading' | 'ok' | 'off' | 'unavailable' | 'offline';

export interface SearchState {
  found: Candidate[];
  reverse: Candidate | undefined;
  status: SearchStatus;
}

export const PAUSE_MS = 450;
const MIN = 3;

async function ask(
  url: string,
  signal: AbortSignal,
): Promise<{ status: SearchStatus; found?: Candidate[]; candidate?: Candidate | null }> {
  try {
    const response = await fetch(url, { credentials: 'same-origin', signal });
    if (!response.ok) return { status: 'unavailable' };
    const body = (await response.json()) as {
      status: string;
      found: Candidate[] | Candidate | null;
    };
    if (body.status === 'off') return { status: 'off' };
    if (body.status === 'unavailable') return { status: 'unavailable' };
    return Array.isArray(body.found)
      ? { status: 'ok', found: body.found }
      : { status: 'ok', candidate: body.found };
  } catch (error) {
    if ((error as { name?: string }).name === 'AbortError') throw error;
    return { status: 'offline' };
  }
}

export function usePlaceSearch(query: string, position: Position | undefined): SearchState {
  const [state, setState] = useState<SearchState>({
    found: [],
    reverse: undefined,
    status: 'idle',
  });
  const text = query.trim();
  const lat = position?.lat;
  const lng = position?.lng;

  // What is typed: after a pause, and only when it is long enough to be a search.
  useEffect(() => {
    if ([...text].length < MIN) {
      setState((now) => ({
        ...now,
        found: [],
        status:
          now.reverse || now.status === 'off' || now.status === 'offline' ? now.status : 'idle',
      }));
      return;
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setState((now) => ({ ...now, found: [], status: 'offline' }));
      return;
    }
    const controller = new AbortController();
    setState((now) => ({ ...now, status: 'loading' }));
    const timer = setTimeout(() => {
      ask(`/api/places?q=${encodeURIComponent(text)}`, controller.signal).then(
        (result) =>
          setState((now) => ({ ...now, found: result.found ?? [], status: result.status })),
        () => undefined,
      );
    }, PAUSE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [text]);

  // What is at the position: once for each position, with nothing to wait for.
  useEffect(() => {
    if (lat === undefined || lng === undefined) {
      setState((now) => ({ ...now, reverse: undefined }));
      return;
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    const controller = new AbortController();
    ask(`/api/places?lat=${lat}&lng=${lng}`, controller.signal).then(
      (result) =>
        setState((now) => ({
          ...now,
          reverse: result.candidate ?? undefined,
          status:
            now.status === 'idle' || now.status === 'loading'
              ? result.status === 'ok'
                ? 'idle'
                : result.status
              : now.status,
        })),
      () => undefined,
    );
    return () => controller.abort();
  }, [lat, lng]);

  return state;
}
