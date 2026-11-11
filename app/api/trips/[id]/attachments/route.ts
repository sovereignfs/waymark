import { accountRoute } from '@/src/access/route';
import { takeUpload } from '@/src/media/server';
import { uploadResponse } from '@/src/trips/attachments-http';
import { serverOps } from '@/src/trips/server';

export const dynamic = 'force-dynamic';

// Adds a file to a trip (DESIGN.md §10.6). The wrapper has found the session and checked `Origin`; the statement that adds the attachment names Organizer or Traveler, so for anyone else the trip is not there.
export const POST = accountRoute(async ({ request, accountId, params }) =>
  uploadResponse(request, accountId, typeof params.id === 'string' ? params.id : '', {
    ...(await serverOps()),
    takeUpload,
  }),
);
