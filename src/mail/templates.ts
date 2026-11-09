import type { Message } from './mailer';

/**
 * The messages the app sends (DESIGN.md §6), plain text, each with one link and nothing of the account but the address it goes to. What the link does is the
 * sign-in library's: a verification link signs the person in, and a reset link is good once.
 */
export function verificationMessage(app: string, to: string, link: string): Message {
  return {
    to,
    subject: `Confirm your address for ${app}`,
    text: `Confirm this address for ${app} and sign in:\n\n${link}\n\nIf you did not ask for this, ignore it: nothing happens until the link is used.\n`,
  };
}

export function resetMessage(app: string, to: string, link: string): Message {
  return {
    to,
    subject: `Reset your ${app} password`,
    text: `Choose a new password for ${app}:\n\n${link}\n\nThe link can be used once and ends soon. Using it signs you out everywhere else. If you did not ask for this, ignore it: your password is not changed.\n`,
  };
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
