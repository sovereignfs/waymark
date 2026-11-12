import { requireAccount, requireSession } from '@/src/auth/session';
import { authSettings } from '@/src/auth/server';
import { getConfig } from '@/src/config/current';
import { serverSealer } from '@/src/crypto/server';
import { getDatabase } from '@/src/db/boot';
import { usageOf } from '@/src/media/service';
import { KIND_LABELS, listPrefs } from '@/src/notices/prefs';
import { KINDS } from '@/src/notices/kinds';
import { NotificationsSection } from '@/src/settings/NotificationsSection';
import { ensureProfile } from '@/src/profile/profile';
import { DataSection } from '@/src/settings/DataSection';
import { DeviceSection } from '@/src/settings/DeviceSection';
import { one, sectionOf } from '@/src/settings/query';
import { ProfileSection } from '@/src/settings/ProfileSection';
import { SecuritySection } from '@/src/settings/SecuritySection';
import { SettingsShell } from '@/src/settings/SettingsShell';
import { signInsOf } from '@/src/settings/sign-ins';

export const metadata = { title: 'Settings' };
export const dynamic = 'force-dynamic';

/** Settings (DESIGN.md §21), at `/settings`, from the avatar menu: the sections are rendered here and handed to the shell, which only shows the one that is open. */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAccount();
  const { user } = await requireSession();
  const query = await searchParams;
  const database = await getDatabase();
  const profile = await ensureProfile(
    database,
    serverSealer(),
    { accountId: user.id, name: user.name, email: user.email },
    Date.now(),
  );
  const signIns = await signInsOf(user.id);
  const prefs = await listPrefs(database, user.id);
  return (
    <SettingsShell
      initial={sectionOf(one(query.section))}
      panels={{
        profile: (
          <ProfileSection
            profile={{
              name: profile.name,
              email: profile.email,
              units: profile.units,
              weekStart: profile.weekStart,
            }}
          />
        ),
        security: (
          <SecuritySection
            passwordMinLength={authSettings()?.passwordMinLength ?? 10}
            hasPassword={signIns.hasPassword}
            sovereign={
              authSettings()?.sovereign
                ? { linkedAccountId: signIns.sovereignAccountId }
                : undefined
            }
            email={user.email}
            result={{
              linked: one(query.linked) === '1',
              unlinked: one(query.unlinked) === '1',
              error: one(query.error) ?? null,
            }}
          />
        ),
        notifications: (
          <NotificationsSection
            // Email goes by this server's own mail, or by the core the people sign in through.
            mail={getConfig().mail !== undefined || authSettings()?.sovereign !== undefined}
            core={authSettings()?.sovereign !== undefined}
            initial={KINDS.map((kind) => ({
              kind,
              label: KIND_LABELS[kind],
              email: prefs[kind].email,
              core: prefs[kind].core,
            }))}
          />
        ),
        data: (
          <DataSection
            usedBytes={await usageOf(database, user.id)}
            limitBytes={getConfig().media.maxAccountBytes}
          />
        ),
        device: <DeviceSection />,
      }}
    />
  );
}
