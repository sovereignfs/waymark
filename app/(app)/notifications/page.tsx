import { requireAccount } from '@/src/auth/session';
import { NotificationsPage } from '@/src/screens/NotificationsPage';

export const metadata = { title: 'Notifications' };

/** Everything a person was told, by day (DESIGN.md §17.1): read in the browser from `/api/notices`, as the bell does. */
export default async function Page() {
  await requireAccount();
  return <NotificationsPage />;
}
