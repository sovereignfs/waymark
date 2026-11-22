import { createSovereign } from '@sovereignfs/sdk';
import { getConfig } from '../config/current';
import { getAuthDatabase } from '../db/boot';
import { readMedia } from '../media/service';
import { readSealed } from '../media/files';
import { accountOfSub } from '../sovereign/identity';
import { gather } from './export';
import { extensionOf } from './format';
import { serverExport } from './server';
import packageJson from '../../package.json';

type Gathered = Awaited<ReturnType<typeof gather>>;

/** One file of records in a person's export: its path in the archive, its kind and its lines. */
export interface RecordsPart {
  readonly path: string;
  readonly kind: string;
  readonly records: readonly Record<string, unknown>[];
}

/** A time Waymark holds in milliseconds, written as the export format asks: ISO 8601 in UTC. Nested values are walked; everything else is as it is. */
export function timed(value: unknown, name = ''): unknown {
  if (typeof value === 'number' && /(At|_at)$/.test(name)) return new Date(value).toISOString();
  if (Array.isArray(value)) return value.map((each) => timed(each));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, field]) => [
        key,
        timed(field, key),
      ]),
    );
  return value;
}

const part = (kind: string, records: readonly unknown[]): RecordsPart => ({
  path: `apps/waymark/records/${kind}.jsonl`,
  kind,
  records: records.map((record) => timed(record) as Record<string, unknown>),
});

/**
 * What Waymark's own export holds (`gather`, DESIGN.md §18), as records of the export format (`contracts/export.md` §3): the profile and the email settings,
 * places, check-ins and the trips the person organizes or travels on (members by name and part only). Kinds with nothing in them are left out.
 */
export function gatheredRecords(data: Gathered): RecordsPart[] {
  const profile = data.profile
    ? [
        {
          name: data.profile.name,
          units: data.profile.units,
          weekStart: data.profile.weekStart,
          shareDefault: data.profile.shareDefault,
        },
      ]
    : [];
  const settings = [
    { email: Object.fromEntries(Object.entries(data.prefs).map(([kind, by]) => [kind, by.email])) },
  ];
  return [
    part('profile', profile),
    part('settings', settings),
    part('places', data.places),
    part('checkins', data.checkins),
    part('trips', data.trips),
  ].filter((each) => each.records.length > 0);
}

/**
 * What the SDK remembers of a token it has seen, so that a replay is refused. Waymark keeps its own sessions with better-auth, so this holds nothing else;
 * it is in memory, since an export asked for twice is the same export (sdk §9.1) and no harm comes of a second.
 */
const seen = new Map<string, { record: unknown; expiresAt: number }>();
const replays = {
  get: (id: string) => {
    const kept = seen.get(id);
    if (!kept || kept.expiresAt < Date.now()) return undefined;
    return kept.record as never;
  },
  set: (id: string, record: unknown, expiresAt: number) => void seen.set(id, { record, expiresAt }),
  delete: (id: string) => void seen.delete(id),
  deleteMatching: () => undefined,
};

/**
 * **Core's export of a person** (`signIn.export`, sdk §9.1): core asks for Waymark's part with a signed token, and the SDK checks it (a replay refused),
 * answers at once with an export in the contract's format, and finishes it as the records and files are written. The part is what Waymark's own export
 * holds: the records above, then each photo of a check-in and each attachment of a trip as the file it is (`apps/waymark/files/…`). A person Waymark does
 * not know gets an empty part. `undefined` where core is not set: the route is then not there.
 */
export async function answerCoreExport(request: Request): Promise<Response | undefined> {
  const config = getConfig();
  const core = config.auth?.sovereign;
  if (!core || !config.url) return undefined;
  const client = createSovereign({
    appUrl: config.url,
    coreUrl: new URL(core.issuer).origin,
    clientId: core.clientId,
    clientSecret: core.clientSecret,
    sessionStore: replays,
  });
  return client.auth.handleExportRequest(
    request,
    { prefix: 'waymark', version: packageJson.version },
    async ({ sub, writer }) => {
      const accountId = await accountOfSub(await getAuthDatabase(), sub);
      if (!accountId) return;
      const deps = await serverExport();
      const data = await gather(deps, accountId);
      if (!data.profile) return;
      for (const each of gatheredRecords(data))
        await writer.addRecords(each.path, each.kind, [...each.records]);
      const photos = new Set<string>();
      for (const checkin of data.checkins)
        for (const id of checkin.photos ?? []) {
          if (photos.has(id)) continue;
          photos.add(id);
          // A photo that has not reached the server is not here; the check-in still names it, as in Waymark's own export.
          const file = await readMedia(deps.media, { accountId, id });
          if (file)
            await writer.addFile(
              `apps/waymark/files/photos/${id}.${extensionOf(file.type)}`,
              file.bytes,
              file.bytes.byteLength,
            );
        }
      for (const file of data.files) {
        const bytes = await readSealed(deps.media.dir, file.fileId, deps.media.ring);
        if (bytes) await writer.addFile(`apps/waymark/files/${file.name}`, bytes, bytes.byteLength);
      }
    },
  );
}
