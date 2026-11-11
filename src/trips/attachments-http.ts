import { bodyOf, refusal } from '../media/http';
import { type Refusal } from '../media/service';
import { type AttachmentDeps, AttachmentRefused, addAttachment } from './attachments';

/**
 * `POST /api/trips/<id>/attachments` (DESIGN.md §10.6): the body is the file. **The title is sent in a header** (`X-Attachment-Title`, URL-encoded) and never in the address, which is logged; `?kind=` says what it is (`receipt`,
 * `booking`, `accommodation`, `ticket`, `other`) and `?day=` the day of the trip it is on. The route (`app/api/trips/[id]/attachments/route.ts`) is wrapped in `accountRoute`; this is what runs for the account it names.
 *
 * Answers: `201` with the attachment; **`404` for a trip the caller may not add to (a Follower, a former member and a stranger alike)**, with no body; `400` for a value that is not an attachment's, `413` for a file that is too big or a
 * trip with as many as the server allows, `415` and `422` for a file that is not a PDF or an image or cannot be read, each with a sentence that repeats nothing.
 */
export const TITLE_HEADER = 'x-attachment-title';

export interface UploadDeps extends AttachmentDeps {
  /** Takes one upload from the account's allowance (60 a minute), as the other uploads do. */
  readonly takeUpload: (accountId: string) => Promise<boolean>;
}

const sentence = (status: number, code: string, message: string): Response =>
  Response.json({ code, message }, { status });

export async function uploadResponse(
  request: Request,
  accountId: string,
  tripId: string,
  deps: UploadDeps,
): Promise<Response> {
  if (!(await deps.takeUpload(accountId))) return new Response(null, { status: 429 });
  const url = new URL(request.url);
  let title: string | undefined;
  try {
    const sent = request.headers.get(TITLE_HEADER);
    title = sent === null ? undefined : decodeURIComponent(sent);
  } catch {
    return sentence(400, 'INVALID', "An attachment's title is 1 to 200 characters on one line.");
  }
  const bytes = await bodyOf(request);
  if (bytes === 'too_big') return refusal('too_big');
  try {
    const added = await addAttachment(deps, accountId, tripId, {
      bytes,
      title,
      kind: url.searchParams.get('kind') ?? undefined,
      dayId: url.searchParams.get('day') ?? undefined,
    });
    return added
      ? Response.json({ attachment: added }, { status: 201 })
      : new Response(null, { status: 404 });
  } catch (error) {
    if (!(error instanceof AttachmentRefused)) throw error;
    if (error.reason === 'invalid') return sentence(400, 'INVALID', error.sentence);
    if (error.reason === 'limit') return sentence(413, 'LIMIT', error.sentence);
    return refusal(error.reason as Refusal);
  }
}
