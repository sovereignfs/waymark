/**
 * Asks `/api/ops` for one online operation (DESIGN.md §15.7), from the browser: **trips, stops, ready, roles and the rest are decided by the server at once**, so they need a connection. The answer is the operation's body
 * (`ok`, and what it returns); an operation that is refused is a `200` with `ok: false`, and says no more than `not_found`. `undefined` when the server could not be reached, so a screen can say what that means.
 */
export interface OpAnswer {
  readonly ok: boolean;
  readonly reason?: string;
  readonly trip?: { readonly id: string };
  readonly choice?: string;
  readonly deletion?: {
    readonly name: string;
    readonly members: number;
    readonly stops: number;
    readonly linkedCheckins: number;
  };
}

export async function askOp(body: Record<string, unknown>): Promise<OpAnswer | undefined> {
  try {
    const reply = await fetch('/api/ops', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!reply.ok) return { ok: false };
    return (await reply.json()) as OpAnswer;
  } catch {
    return undefined;
  }
}

/** The sentence for an operation that did not happen. */
export const NO_CONNECTION = 'This is done on the server, and there is no connection to it now.';
export const NOT_DONE = 'That could not be done. The trip may have changed.';
