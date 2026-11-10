import { requireAccount } from '@/src/auth/session';
import { CheckinsView } from '@/src/screens/CheckinsView';

export const metadata = { title: 'Check-in' };

/** One check-in (DESIGN.md §20.6), beside the timeline on a wide screen and a page on a narrow one: the same page as `/checkins`, which draws what the address says. */
export default async function Page() {
  await requireAccount();
  return <CheckinsView />;
}
