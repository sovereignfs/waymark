/**
 * What to tell a person when sign-in goes wrong. better-auth answers with a code and an English message meant for developers; these say what the
 * person can do. A code that is not here falls back to better-auth's own message if it is short, and failing that to a plain sentence. **No message
 * says whether an email address has an account** (DESIGN.md §6).
 */
const BY_CODE: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD:
    'That email address and password do not match. Check them and try again.',
  INVALID_PASSWORD: 'That password is not right.',
  PASSWORD_TOO_SHORT: 'That password is too short.',
  PASSWORD_TOO_LONG: 'That password is too long.',
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL:
    'There is already an account with that email address. Try signing in instead.',
  SIGNUP_CLOSED: 'Sign-up is closed on this instance.',
  UNAUTHORIZED: 'You need to sign in first.',
  SESSION_NOT_FRESH: 'For your security, sign out, sign in again, and then try this once more.',
  FAILED_TO_UNLINK_LAST_ACCOUNT:
    'Sovereign is the only way you can sign in here, so it cannot be unlinked.',
  LINKING_DIFFERENT_EMAILS_NOT_ALLOWED:
    'That Sovereign account uses a different email address from this account. Both must use the same one.',
  NO_PASSWORD_ACCOUNT: 'This account signs in through Sovereign, which has its own.',
  EMAIL_NOT_VERIFIED:
    'Confirm your email address first: a link was sent to it. Open the link, and you are signed in.',
  INVALID_TOKEN: 'That link is not good any more. Ask for a new one.',
};

export interface AuthError {
  code?: string | undefined;
  message?: string | undefined;
  status?: number | undefined;
}

export function messageFor(
  error: AuthError | null | undefined,
  fallback = 'Something went wrong. Please try again.',
): string {
  if (!error) return fallback;
  if (error.status === 429) return 'Too many tries. Wait a few seconds and try again.';
  const known = error.code ? BY_CODE[error.code] : undefined;
  if (known) return known;
  if (error.status === 403 && /closed/i.test(error.message ?? ''))
    return 'Sign-up is closed on this instance.';
  return error.message && error.message.length < 140 ? error.message : fallback;
}

/**
 * The `?error=` code better-auth puts on the sign-in page when a sign-in through Sovereign fails after the person has left and come back. These are not API
 * errors: some are our own policy (a closed sign-up) and some are core's (it refused the client). Each says what the person can do, and none says more about
 * an account than they already know.
 */
const BY_OAUTH_ERROR: Record<string, string> = {
  account_not_linked:
    'There is already an account here with that email address, signed in another way. Sign in the way you did before, and link Sovereign from your account’s security settings.',
  email_does_not_match:
    'That Sovereign account uses a different email address from this account. Both must use the same one to be linked.',
  account_already_linked_to_different_user:
    'That Sovereign account is already linked to another account here.',
  unable_to_link_account: 'Sovereign could not be linked to this account. Try again.',
  SIGNUP_CLOSED: 'Sign-up is closed on this instance. Ask whoever runs it to let you in.',
  unable_to_create_user: 'Sign-up is closed on this instance. Ask whoever runs it to let you in.',
  signup_disabled: 'Sign-up is closed on this instance. Ask whoever runs it to let you in.',
  email_not_verified:
    'Sovereign has not confirmed your email address yet. Confirm it there and try again.',
  email_not_found: 'Sovereign did not share an email address, which this app needs.',
  access_denied: 'You declined to share your Sovereign account, so you were not signed in.',
  invalid_code: 'Signing in with Sovereign did not complete. Try again.',
  state_mismatch: 'Your sign-in took too long or was started somewhere else. Start again.',
  please_restart_the_process:
    'Your sign-in took too long or was started somewhere else. Start again.',
};

/** A message for the `?error=` on the sign-in page, or null when there is none to show. */
export function oauthErrorMessage(code: string | undefined): string | null {
  if (!code) return null;
  return (
    BY_OAUTH_ERROR[code] ??
    'Something went wrong with Sovereign. Try again, or ask whoever runs this instance.'
  );
}
