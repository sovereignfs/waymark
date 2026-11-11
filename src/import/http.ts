import { isId } from '../checkins/validate';
import { IMPORT_MAX_BYTES } from './files';
import type { ImportDeps, ImportSource } from './job';
import { SENTENCES, cancelImport, createImport, listImportsOf } from './service';

/**
 * What `/api/imports` answers (DESIGN.md §16): the signed-in account's own imports, an upload, and a cancel. The account is the session's and every statement names it, so there is no way to see or stop
 * another's. A refusal is a status, a code and a sentence a person can act on; it never says what was in the file.
 */
const noStore = { 'cache-control': 'no-store' };
const SOURCES: readonly ImportSource[] = ['swarm'];
const STATUS = { unavailable: 404, busy: 409, too_big: 413, empty: 400 } as const;

export async function listResponse(accountId: string, deps: ImportDeps): Promise<Response> {
  return Response.json(
    {
      available: Object.keys(deps.readers),
      imports: await listImportsOf(deps, accountId),
    },
    { headers: noStore },
  );
}

async function* chunksOf(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/** `POST /api/imports?source=swarm` with the file as the body. `take` is the per-account limit on uploads. */
export async function uploadResponse(
  request: Request,
  accountId: string,
  deps: ImportDeps,
  take: () => Promise<boolean>,
): Promise<Response> {
  const source = new URL(request.url).searchParams.get('source') ?? 'swarm';
  if (!(SOURCES as readonly string[]).includes(source))
    return Response.json({ code: 'BAD_REQUEST' }, { status: 400 });
  if (!(await take())) return new Response(null, { status: 429 });
  // The length it says is checked first, and the stream is cut off at the limit whatever it said.
  const said = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(said) && said > IMPORT_MAX_BYTES)
    return Response.json({ code: 'TOO_BIG', message: SENTENCES.too_big }, { status: 413 });
  const made = await createImport(deps, {
    accountId,
    source: source as ImportSource,
    body: request.body ? chunksOf(request.body) : (async function* () {})(),
  });
  if (!made.ok)
    return Response.json(
      { code: made.reason.toUpperCase(), message: SENTENCES[made.reason] },
      { status: STATUS[made.reason] },
    );
  return Response.json({ id: made.id }, { status: 201, headers: noStore });
}

export async function cancelResponse(
  accountId: string,
  id: string,
  deps: ImportDeps,
): Promise<Response> {
  if (!isId(id) || !(await cancelImport(deps, accountId, id)))
    return new Response(null, { status: 404 });
  return Response.json({ cancelled: true }, { headers: noStore });
}
