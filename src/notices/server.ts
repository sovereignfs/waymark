import { getConfig } from '../config/current';
import { site } from '../site';
import type { Delivery } from './notices';

/**
 * How notices reach people beyond the bell on this server (DESIGN.md §17.2): by email when `WAYMARK_SMTP_HOST` is set, and only then. Whatever raises a notice passes this to `raiseNotice`, so the answer is one
 * place's and a notice never queues mail that nothing could send.
 */
export function noticeDelivery(): Delivery {
  const { mail, url } = getConfig();
  return mail && url ? { mail: { app: site.name, url } } : {};
}
