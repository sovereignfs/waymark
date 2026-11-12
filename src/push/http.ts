import { readCapped } from '../access/body';
import type { PushSettings } from './config';
import { type PushDeps, countDevices, subscribe, unsubscribe } from './subscriptions';

/**
 * What `/api/push` reads and changes (DESIGN.md §17.3): the signed-in account's devices that can be told by Web Push. `GET` says whether this server can (an instance without a key says no, and Settings says so), the public key a browser
 * subscribes with, and how many devices the account has push on in; `POST { endpoint, keys }` turns it on for a browser; `DELETE { endpoint }` turns it off. Every statement names the account, so another person's devices are not found.
 * The endpoint must be a push service's (`subscriptions.ts`): a refusal says so in a sentence that repeats nothing sent.
 */
export interface PushHttpDeps extends PushDeps {
  /** Absent: this server has no Web Push key. */
  readonly settings: PushSettings | undefined;
}

const noStore = { 'cache-control': 'no-store' };
const bad = () => Response.json({ code: 'BAD_REQUEST' }, { status: 400 });

export async function readPush(accountId: string, deps: PushHttpDeps): Promise<Response> {
  return Response.json(
    deps.settings
      ? {
          available: true,
          publicKey: deps.settings.publicKey,
          devices: await countDevices(deps.database, accountId),
        }
      : { available: false },
    { headers: noStore },
  );
}

async function bodyOf(request: Request): Promise<Record<string, unknown> | undefined> {
  const text = await readCapped(request, 4096);
  if (text === null) return undefined;
  try {
    const body: unknown = JSON.parse(text);
    return typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export async function turnOn(
  request: Request,
  accountId: string,
  deps: PushHttpDeps,
): Promise<Response> {
  if (!deps.settings) return Response.json({ code: 'PUSH_OFF' }, { status: 404 });
  const body = await bodyOf(request);
  if (!body || Object.keys(body).some((key) => !['endpoint', 'keys'].includes(key))) return bad();
  const result = await subscribe(deps, accountId, { endpoint: body.endpoint, keys: body.keys });
  if (result.ok) return readPush(accountId, deps);
  if (result.reason === 'too_many')
    return Response.json(
      {
        code: 'TOO_MANY',
        sentence: 'Push is on in as many devices as Waymark allows. Turn it off in one first.',
      },
      { status: 409 },
    );
  return Response.json(
    {
      code: 'BAD_REQUEST',
      sentence:
        result.reason === 'host'
          ? 'That is not a push service Waymark will send to.'
          : 'That is not a push subscription.',
    },
    { status: 400 },
  );
}

export async function turnOff(
  request: Request,
  accountId: string,
  deps: PushHttpDeps,
): Promise<Response> {
  const body = await bodyOf(request);
  if (
    !body ||
    Object.keys(body).some((key) => key !== 'endpoint') ||
    typeof body.endpoint !== 'string'
  )
    return bad();
  const gone = await unsubscribe(deps, accountId, body.endpoint);
  return gone ? readPush(accountId, deps) : Response.json({ code: 'NOT_FOUND' }, { status: 404 });
}
