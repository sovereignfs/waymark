import type { Problem } from '../config';
import type { MailSettings } from './mailer';

/**
 * `WAYMARK_SMTP_HOST`, `_PORT` (587 by default; 465 is SMTPS), `_USER` and `_PASSWORD` (or `_PASSWORD_FILE`; both or neither) and `_FROM` (required with a host:
 * a message nobody could answer is not sent). No host means no mail, and the other settings are not read. A wrong setting is a problem that stops the server,
 * and no message carries a value (the password least of all).
 */
export function resolveMail(
  read: (name: string) => string | undefined,
  problems: Problem[],
): MailSettings | undefined {
  const host = read('WAYMARK_SMTP_HOST');
  if (host === undefined) return undefined;
  const before = problems.length;

  if (!/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host))
    problems.push('WAYMARK_SMTP_HOST is a host name or an address, with no scheme or path.');
  const rawPort = read('WAYMARK_SMTP_PORT');
  let port = 587;
  if (rawPort !== undefined) {
    const parsed = Number(rawPort);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535)
      problems.push('WAYMARK_SMTP_PORT is a port, 1 to 65535.');
    else port = parsed;
  }
  const from = read('WAYMARK_SMTP_FROM');
  if (from === undefined)
    problems.push('WAYMARK_SMTP_HOST is set, and mail needs WAYMARK_SMTP_FROM as well.');
  else if (!/^[^\r\n<>]*<?[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>?$/.test(from))
    problems.push(
      'WAYMARK_SMTP_FROM is an address, or a name and an address: Waymark <waymark@example.com>.',
    );
  const user = read('WAYMARK_SMTP_USER');
  const password = read('WAYMARK_SMTP_PASSWORD');
  if ((user === undefined) !== (password === undefined))
    problems.push('WAYMARK_SMTP_USER and WAYMARK_SMTP_PASSWORD go together: both or neither.');

  if (problems.length > before || from === undefined) return undefined;
  return { host, port, secure: port === 465, user, password, from };
}
