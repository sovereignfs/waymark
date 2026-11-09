export const dynamic = 'force-dynamic';

/**
 * The instance asks this before it sends anyone to the app (the manifest's `health`), and a container's health check and CI ask it too. Until the
 * database layer (1.5) it answers for the process alone; then it answers 200 only when the database does and `/data` is writable (DESIGN.md §25).
 */
export function GET() {
  return Response.json({ status: 'ok' }, { headers: { 'cache-control': 'no-store' } });
}
