import { answerCoreExport } from '@/src/portability/core-export';

export const dynamic = 'force-dynamic';

/**
 * Core asks for a person's part of their export (`signIn.export`): its signed token is the credential, checked by the SDK, with no session, cookie or
 * `Origin`. Not found where Sovereign sign-in is not set up; any other method is refused by Next with a 405.
 */
export async function POST(request: Request): Promise<Response> {
  return (await answerCoreExport(request)) ?? new Response(null, { status: 404 });
}
