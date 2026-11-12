import { getConfig } from '../config/current';
import { site } from '../site';
import type { Delivery } from './notices';

/**
 * How notices reach people beyond the bell on this server (DESIGN.md §17.2): by email when `WAYMARK_SMTP_HOST` is set, and through a Sovereign core's bell and email where the people sign in through one. Whatever raises a notice passes this to `raiseNotice`, so the answer is one
 * place's and a notice never queues mail that nothing could send.
 */
export function noticeDelivery(): Delivery {
  const { mail, url, auth } = getConfig();
  if (!url) return {};
  return {
    ...(mail ? { mail: { app: site.name, url } } : {}),
    // Core's bell and core's email, where the people here sign in through a core (DESIGN.md §19.4).
    ...(auth?.sovereign ? { core: true as const } : {}),
  };
}
