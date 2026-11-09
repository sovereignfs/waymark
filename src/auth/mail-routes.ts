/**
 * The sign-in routes that exist only with mail (DESIGN.md §6): asking for a reset and using one, and sending and using a verification link. **Without mail
 * they are not mounted**: they answer 404, as a route that is not there, and not a refusal that says mail is off. The path is the one better-auth serves, under
 * `/api/auth`.
 */
const ONLY_WITH_MAIL = [
  '/api/auth/request-password-reset',
  '/api/auth/reset-password',
  '/api/auth/send-verification-email',
  '/api/auth/verify-email',
];

export function needsMail(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, '');
  return ONLY_WITH_MAIL.some((each) => path === each || path.startsWith(`${each}/`));
}
