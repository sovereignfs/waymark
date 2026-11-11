import type { Message } from './mailer';

/**
 * What goes in an HTML message is escaped, and the message is simple on purpose: a paragraph, a link, nothing loaded from anywhere (no image, no style sheet, no tracking), so that it reads the same in
 * any mail program and says nothing to a third party by being opened.
 */
export const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** A message's HTML: its paragraphs (blank-line separated) and a link on a line of its own for an address in them. */
export function simpleHtml(text: string): string {
  const link = /(https?:\/\/[^\s<>"]+)/g;
  const body = text
    .trim()
    .split(/\n{2,}/)
    .map(
      (paragraph) =>
        `<p>${escapeHtml(paragraph)
          .replace(link, (url) => `<a href="${url}">${url}</a>`)
          .replace(/\n/g, '<br>')}</p>`,
    )
    .join('\n');
  return `<!doctype html><html><body>${body}</body></html>`;
}

const withHtml = (message: Message): Message => ({ ...message, html: simpleHtml(message.text) });

/**
 * The messages the app sends (DESIGN.md §6), plain text, each with one link and nothing of the account but the address it goes to. What the link does is the
 * sign-in library's: a verification link signs the person in, and a reset link is good once.
 */
export function verificationMessage(app: string, to: string, link: string): Message {
  return withHtml({
    kind: 'verification',
    to,
    subject: `Confirm your address for ${app}`,
    text: `Confirm this address for ${app} and sign in:\n\n${link}\n\nIf you did not ask for this, ignore it: nothing happens until the link is used.\n`,
  });
}

export function resetMessage(app: string, to: string, link: string): Message {
  return withHtml({
    kind: 'reset',
    to,
    subject: `Reset your ${app} password`,
    text: `Choose a new password for ${app}:\n\n${link}\n\nThe link can be used once and ends soon. Using it signs you out everywhere else. If you did not ask for this, ignore it: your password is not changed.\n`,
  });
}

/**
 * A notice, by email (DESIGN.md §25.2): its title and what it says, one link to where it goes, and one to Settings, where the person turns email off. The title is
 * a card's or a board's, as the person wrote it, and so is in the message; Settings says so before it is turned on.
 */
export function notificationMessage(
  app: string,
  to: string,
  title: string,
  body: string | undefined,
  link: string,
  settingsLink: string,
): Message {
  return {
    to,
    subject: title,
    text: `${title}\n\n${body ? `${body}\n\n` : ''}${link}\n\nYou get this because you turned on email from ${app}. To stop it: ${settingsLink}\n`,
  };
}
