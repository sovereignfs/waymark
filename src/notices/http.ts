import { readCapped } from '../access/body';
import { isId } from '../checkins/validate';
import { type NoticeDeps, PAGE, listNotices, markAllRead, markRead, unreadCount } from './notices';

/**
 * What `/api/notices` reads and changes (DESIGN.md §17.1): the signed-in account's own notices. The account is the session's and every statement names it, so there is no way to ask for another's.
 * The handlers take what they need, so that a test can call them as a second person.
 */
const noStore = { 'cache-control': 'no-store' };

/** What the bell and the page show: how many are unread (counted by the database, not by the list) and the newest notices. */
export async function readNotices(accountId: string, deps: NoticeDeps): Promise<Response> {
  const [notices, unread] = await Promise.all([
    listNotices(deps, accountId, PAGE),
    unreadCount(deps, accountId),
  ]);
  return Response.json(
    {
      unread,
      notices: notices.map((notice) => ({
        id: notice.id,
        kind: notice.kind,
        at: notice.at,
        read: notice.read,
        title: notice.title,
        detail: notice.detail,
        href: notice.href,
      })),
    },
    { headers: noStore },
  );
}

/** Marks notices read: `{ ids: [...] }` for some, `{ all: true }` for every one. Marking is the only change a person makes to a notice. */
export async function changeNotices(
  request: Request,
  accountId: string,
  deps: NoticeDeps,
): Promise<Response> {
  const text = await readCapped(request, 8192);
  if (text === null) return Response.json({ code: 'TOO_LARGE' }, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return Response.json({ code: 'BAD_REQUEST' }, { status: 400 });
  }
  const bad = Response.json({ code: 'BAD_REQUEST' }, { status: 400 });
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return bad;
  const keys = Object.keys(body);
  if (keys.length !== 1) return bad;
  const asked = body as { ids?: unknown; all?: unknown };
  if (asked.all === true) {
    const marked = await markAllRead(deps, accountId);
    return Response.json({ marked }, { headers: noStore });
  }
  if (!Array.isArray(asked.ids) || asked.ids.length > PAGE || !asked.ids.every(isId)) return bad;
  const marked = await markRead(deps, accountId, asked.ids as string[]);
  return Response.json({ marked }, { headers: noStore });
}
