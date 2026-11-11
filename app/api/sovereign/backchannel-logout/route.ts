import { handleBackChannelLogout } from '@/src/sovereign/http';
import { noticeDeps } from '@/src/sovereign/server';

export const dynamic = 'force-dynamic';

/**
 * Sovereign's notice that a person's session at Sovereign ended (DESIGN.md §19.2). Its signed token is the credential: no session, no cookie, no `Origin`. Not found where Sovereign sign-in is not
 * set up; any other method is refused by Next with a 405.
 */
export async function POST(request: Request): Promise<Response> {
  const deps = await noticeDeps();
  if (!deps) return new Response(null, { status: 404 });
  return handleBackChannelLogout(request, deps);
}
