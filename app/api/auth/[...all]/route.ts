import { toNextJsHandler } from 'better-auth/next-js';
import { getAuth, mailAvailable } from '@/src/auth/server';
import { needsMail } from '@/src/auth/mail-routes';

// Every request is answered by better-auth, mounted at /api/auth. With local sign-in off there is nothing mounted: 404, as if the routes did not
// exist (DESIGN.md §6).
export const dynamic = 'force-dynamic';

const notFound = () => new Response(null, { status: 404 });

export async function GET(request: Request): Promise<Response> {
  const auth = await getAuth();
  if (!auth || (!mailAvailable() && needsMail(new URL(request.url).pathname))) return notFound();
  return toNextJsHandler(auth).GET(request);
}

export async function POST(request: Request): Promise<Response> {
  const auth = await getAuth();
  if (!auth || (!mailAvailable() && needsMail(new URL(request.url).pathname))) return notFound();
  return toNextJsHandler(auth).POST(request);
}
