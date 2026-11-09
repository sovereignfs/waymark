import { readCapped } from '../access/body';
import type { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import {
  ProfileError,
  type Profile,
  type ProfilePatch,
  getProfile,
  updateProfile,
} from '../profile/profile';

/**
 * What `/api/settings` reads and changes (DESIGN.md §21): the signed-in account's own profile. The account is the session's and every statement names it, so there is no way to
 * ask for another's. The handlers take what they need, so that a test can call them as a second person.
 */
export interface SettingsDeps {
  readonly database: Database;
  readonly sealer: Sealer;
  readonly now: () => number;
}

const view = (profile: Profile) => ({
  name: profile.name,
  email: profile.email,
  units: profile.units,
  weekStart: profile.weekStart,
  shareDefault: profile.shareDefault,
});

/** What a request may change. The address is not here: it is the one the person signs in with. */
const FIELDS = new Set(['name', 'units', 'weekStart', 'shareDefault']);
const noStore = { 'cache-control': 'no-store' };

export async function readSettings(accountId: string, deps: SettingsDeps): Promise<Response> {
  const profile = await getProfile(deps.database, deps.sealer, accountId);
  if (!profile) return new Response(null, { status: 404 });
  return Response.json(view(profile), { headers: noStore });
}

export async function changeSettings(
  request: Request,
  accountId: string,
  deps: SettingsDeps,
): Promise<Response> {
  const text = await readCapped(request, 4096);
  if (text === null) return Response.json({ code: 'TOO_LARGE' }, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return Response.json({ code: 'BAD_REQUEST' }, { status: 400 });
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    return Response.json({ code: 'BAD_REQUEST' }, { status: 400 });
  if (Object.keys(body).some((key) => !FIELDS.has(key)))
    return Response.json({ code: 'BAD_REQUEST' }, { status: 400 });
  try {
    const updated = await updateProfile(
      deps.database,
      deps.sealer,
      accountId,
      body as ProfilePatch,
      deps.now(),
    );
    if (!updated) return new Response(null, { status: 404 });
    return Response.json(view(updated), { headers: noStore });
  } catch (error) {
    // The message names what is wrong and never the value; a person is told only that it could not be saved.
    if (error instanceof ProfileError)
      return Response.json({ code: 'BAD_REQUEST' }, { status: 400 });
    throw error;
  }
}
