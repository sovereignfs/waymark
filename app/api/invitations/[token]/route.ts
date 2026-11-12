import { preview } from '@/src/invitations/http';
import { serverInvite } from '@/src/invitations/server';

export const dynamic = 'force-dynamic';

/** What a person sees at `/invite/<token>` before signing in: the trip's name, its dates and who invited (DESIGN.md §11.2). The same `404` for every link that cannot be used. */
export async function GET(_request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  return preview(token, await serverInvite());
}
