import { getConfig } from '../config/current';
import { serverSealer } from '../crypto/server';
import { getDatabase } from '../db/boot';
import type { Mailer } from './mailer';
import type { OutboxDeps } from './outbox';
import { smtpMailer } from './smtp';

/** The SMTP mailer the job sends with, made once from the settings the server started with; undefined with no `WAYMARK_SMTP_HOST`, and then the outbox is not worked. */
let mailer: Mailer | undefined;
export function serverMailer(): Mailer | undefined {
  const settings = getConfig().mail;
  if (!settings) return undefined;
  mailer ??= smtpMailer(settings);
  return mailer;
}

export async function serverOutbox(now: () => number = Date.now): Promise<OutboxDeps> {
  return { database: await getDatabase(), sealer: serverSealer(), now };
}
