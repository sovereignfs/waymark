import { readCapped } from '../access/body';
import type { Database } from '../db/client';
import { CHANNELS, KIND_LABELS, isChannel, isKind, listPrefs, setPref } from './prefs';
import { KINDS } from './kinds';

/**
 * What `/api/notices/prefs` reads and changes (DESIGN.md §17.2, §21): the signed-in account's own choices of what is emailed. `mail` says whether this server can send mail at all, so that Settings can say the
 * bell is the only channel when it cannot. A choice is stored whether or not mail is set up (it applies when it is); nothing but the account's own rows is read or written.
 */
export interface PrefsDeps {
  readonly database: Database;
  readonly mail: boolean;
  readonly now: () => number;
}

const noStore = { 'cache-control': 'no-store' };
const bad = () => Response.json({ code: 'BAD_REQUEST' }, { status: 400 });

export async function readPrefs(accountId: string, deps: PrefsDeps): Promise<Response> {
  const prefs = await listPrefs(deps.database, accountId);
  return Response.json(
    {
      mail: deps.mail,
      channels: CHANNELS,
      kinds: KINDS.map((kind) => ({ kind, label: KIND_LABELS[kind], ...prefs[kind] })),
    },
    { headers: noStore },
  );
}

/** `{ kind, channel, on }`: one choice. Anything else is refused. */
export async function changePref(
  request: Request,
  accountId: string,
  deps: PrefsDeps,
): Promise<Response> {
  const text = await readCapped(request, 1024);
  if (text === null) return Response.json({ code: 'TOO_LARGE' }, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return bad();
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return bad();
  const asked = body as Record<string, unknown>;
  if (Object.keys(asked).some((key) => !['kind', 'channel', 'on'].includes(key))) return bad();
  if (!isKind(asked.kind) || !isChannel(asked.channel) || typeof asked.on !== 'boolean')
    return bad();
  await setPref(deps.database, accountId, asked.kind, asked.channel, asked.on, deps.now());
  return readPrefs(accountId, deps);
}
