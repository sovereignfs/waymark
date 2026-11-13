/**
 * Asks `/api/ops` for one online operation (DESIGN.md §15.7), from the browser: **trips, stops, ready, roles and the rest are decided by the server at once**, so they need a connection. The answer is the operation's body
 * (`ok`, and what it returns); an operation that is refused is a `200` with `ok: false`, and says no more than `not_found`. `undefined` when the server could not be reached, so a screen can say what that means.
 */
export interface OpAnswer {
  readonly ok: boolean;
  readonly reason?: string;
  /** The sentence for a refusal other than `not_found`. */
  readonly sentence?: string;
  /** For `reason: 'items'`: the ids of the days that have items. */
  readonly days?: readonly string[];
  readonly trip?: { readonly id: string };
  readonly choice?: string;
  /** For `invite.create`: the invitation made, with its link (shown once) and whether this server can send mail. */
  readonly invitation?: {
    readonly id: string;
    readonly link: string;
    readonly mail: boolean;
    readonly via: 'link' | 'account' | 'email' | 'directory';
    readonly expiresAt: number;
  };
  /** For `people.directory`: whether core's directory answered (`off`: there is none to ask here) and who it named. */
  readonly directory?: 'on' | 'off' | 'failed';
  readonly people?: readonly { readonly sub: string; readonly name: string }[];
  /** For `invite.list`. */
  readonly invitations?: readonly {
    readonly id: string;
    readonly role: 'organizer' | 'traveler' | 'follower';
    readonly via: 'link' | 'account' | 'email' | 'directory';
    readonly email: string | undefined;
    /** The name core's directory gave, for an invitation made from it. */
    readonly name?: string | undefined;
    readonly createdAt: number;
    readonly lastSentAt: number;
    readonly expiresAt: number;
  }[];
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
