'use client';

import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

/** A notice as the page and the bell hold it (`/api/notices`). */
export interface NoticeView {
  readonly id: string;
  readonly kind: string;
  readonly at: number;
  readonly read: boolean;
  readonly title: string;
  readonly detail?: string | undefined;
  readonly href?: string | undefined;
}

/**
 * What a person was told, in the browser (DESIGN.md §17.1): **one copy, shared by the bell and by `/notifications`**, so what one changes the other shows at once. Notices are an online thing (§15.7): they are
 * read when the app opens, every minute while the window is in view, when it comes to the front and when the network returns, and what was last had stays while a read fails, so offline the bell says nothing of
 * the network. Marking read is shown at once, sent after, and put right by reading again if the server did not take it.
 */
export interface Notices {
  readonly notices: readonly NoticeView[];
  /** How many are unread, as the server counted them. */
  readonly unread: number;
  /** `loading` until the first read ends; `failed` if it could not be had and there is nothing to show. */
  readonly status: 'loading' | 'ready' | 'failed';
  readonly read: (ids: readonly string[]) => void;
  readonly readAll: () => void;
  readonly refresh: () => Promise<void>;
}

const EMPTY: Notices = {
  notices: [],
  unread: 0,
  status: 'loading',
  read: () => undefined,
  readAll: () => undefined,
  refresh: async () => undefined,
};
const Context = createContext<Notices>(EMPTY);
export const useNotices = (): Notices => useContext(Context);

/** How often the notices are read again while the window is in view. */
export const REFRESH_MS = 60_000;

async function send(body: unknown): Promise<boolean> {
  try {
    const reply = await fetch('/api/notices', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return reply.ok;
  } catch {
    return false;
  }
}

export function NoticesProvider({ children }: { children: ReactNode }) {
  const [notices, setNotices] = useState<readonly NoticeView[]>([]);
  const [unread, setUnread] = useState(0);
  const [status, setStatus] = useState<Notices['status']>('loading');
  const latest = useRef(notices);
  latest.current = notices;
  // A change in flight, so that a read that began before it does not put the old state back over it.
  const changing = useRef(0);

  const refresh = useCallback(async () => {
    const asked = changing.current;
    try {
      const reply = await fetch('/api/notices', { cache: 'no-store' });
      if (!reply.ok) throw new Error('refused');
      const page = (await reply.json()) as { unread: number; notices: NoticeView[] };
      if (asked !== changing.current) return;
      setNotices(page.notices);
      setUnread(page.unread);
      setStatus('ready');
    } catch {
      // Offline, or refused: what there was stays, and a first read that failed says so.
      setStatus((was) => (was === 'loading' ? 'failed' : was));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const again = () => document.visibilityState === 'visible' && void refresh();
    const tick = setInterval(again, REFRESH_MS);
    document.addEventListener('visibilitychange', again);
    window.addEventListener('focus', again);
    window.addEventListener('online', again);
    return () => {
      clearInterval(tick);
      document.removeEventListener('visibilitychange', again);
      window.removeEventListener('focus', again);
      window.removeEventListener('online', again);
    };
  }, [refresh]);

  const change = useCallback(
    (body: unknown, show: () => void) => {
      changing.current += 1;
      show();
      void send(body).then((ok) => {
        changing.current += 1;
        // Refused or not reached: read again, which puts it right.
        if (!ok) void refresh();
      });
    },
    [refresh],
  );

  const value = useMemo<Notices>(
    () => ({
      notices,
      unread,
      status,
      read: (ids) => {
        const named = new Set(ids);
        const was = latest.current.filter((each) => named.has(each.id) && !each.read).length;
        if (was === 0) return;
        change({ ids: [...named] }, () => {
          setNotices((now) =>
            now.map((each) => (named.has(each.id) ? { ...each, read: true } : each)),
          );
          setUnread((now) => Math.max(0, now - was));
        });
      },
      readAll: () => {
        if (latest.current.every((each) => each.read) && unread === 0) return;
        change({ all: true }, () => {
          setNotices((now) => now.map((each) => ({ ...each, read: true })));
          setUnread(0);
        });
      },
      refresh,
    }),
    [notices, unread, status, change, refresh],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
