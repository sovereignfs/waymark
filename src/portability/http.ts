import { isId } from '../checkins/validate';
import { type ExportDeps, deleteExport, listExportsOf, openExport, requestExport } from './export';

/**
 * What `/api/exports` answers (DESIGN.md §22): the signed-in account's own exports, a request for one, its download and its deletion. The account is the session's and every statement names it, so there is no
 * way to see, download or delete another's: another person's, one that is not ready, one that has run out and one that never was are the same answer, not found.
 */
const noStore = { 'cache-control': 'no-store' };

export async function listResponse(accountId: string, deps: ExportDeps): Promise<Response> {
  return Response.json({ exports: await listExportsOf(deps, accountId) }, { headers: noStore });
}

/** `POST /api/exports`: asks for an export. `take` is the per-account limit on how often. */
export async function requestResponse(
  accountId: string,
  deps: ExportDeps,
  take: () => Promise<boolean>,
): Promise<Response> {
  if (!(await take())) return new Response(null, { status: 429 });
  const made = await requestExport(deps, accountId);
  if (!made.ok)
    return Response.json(
      {
        code: 'BUSY',
        message: 'An export is already being made. It will be here when it is ready.',
      },
      { status: 409, headers: noStore },
    );
  return Response.json({ id: made.id }, { status: 201, headers: noStore });
}

/** The download: the ZIP, a chunk at a time from the sealed file, as an attachment, never cached and never sniffed. */
export async function downloadResponse(
  accountId: string,
  id: string,
  deps: ExportDeps,
): Promise<Response> {
  if (!isId(id)) return new Response(null, { status: 404 });
  const file = await openExport(deps, accountId, id);
  if (!file) return new Response(null, { status: 404 });
  const iterator = file.stream;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return(undefined);
    },
  });
  const day = new Date(deps.now()).toISOString().slice(0, 10);
  return new Response(body, {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="waymark-export-${day}.zip"`,
      'content-length': String(file.bytes),
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
      'content-security-policy': "default-src 'none'; sandbox",
      'cross-origin-resource-policy': 'same-origin',
    },
  });
}

export async function deleteResponse(
  accountId: string,
  id: string,
  deps: ExportDeps,
): Promise<Response> {
  if (!isId(id) || !(await deleteExport(deps, accountId, id)))
    return new Response(null, { status: 404 });
  return Response.json({ deleted: true }, { headers: noStore });
}
