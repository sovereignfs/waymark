import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { nextCookies } from 'better-auth/next-js';
import { decryptOAuthToken } from 'better-auth/oauth2';
import { genericOAuth, twoFactor } from 'better-auth/plugins';
import { passkey } from '@better-auth/passkey';
import type { Database } from '../db/client';
import type { Mailer } from '../mail/mailer';
import { resetMessage, verificationMessage } from '../mail/templates';
import * as postgresAuth from '../db/schema/postgres/auth';
import * as sqliteAuth from '../db/schema/sqlite/auth';
import {
  INVITE_HEADER,
  type AuthSettings,
  SIGNUP_CLOSED,
  SOVEREIGN_PROVIDER_ID,
  SOVEREIGN_SCOPES,
} from './config';
import { countUsers } from './users';

/**
 * Sign-in (DESIGN.md §19.1) on better-auth, stored in the auth store through its Drizzle adapter. Built from settings and a database and nothing
 * global, so a test can make one against any of the three databases (`test-support.ts`); the server makes the one it serves (`server.ts`).
 */
export interface AuthDependencies {
  settings: AuthSettings;
  /** What the app calls itself, for the places a person sees it. */
  name: string;
  /** The auth store's database. */
  database: Database;
  /**
   * Where mail goes, if there is any. **With a mailer an address is verified before the first sign-in (the link signs in) and a forgotten password is reset by
   * a single-use link that ends every other session; without one, neither exists** and the routes that would do them are not mounted (`app/api/auth`).
   */
  mailer?: Mailer | undefined;
  /**
   * Called once an account has been made, after the sign-up policy has let it be (`databaseHooks.user.create.after`): Waymark makes the account's profile here
   * (2.7). The account and the profile are in two stores, which cannot share a transaction, so the profile is made idempotently (its key is the account), and a
   * profile that is somehow missing is made when it is first read. A failure here does not undo the account: it is logged by kind and left to that.
   */
  /** Whether a token opens an invitation that can still be used: asked when an account is made under the sign-up policy `invite` (DESIGN.md §6.2). */
  invitationOpen?: ((token: string) => Promise<boolean>) | undefined;
  onAccountCreated?:
    ((account: { id: string; name: string; email: string }) => Promise<void>) | undefined;
  /**
   * Called when a sign-in through core has ended, with the account, the person's `sub` and **the refresh token core gave** (it gives one for the `offline_access` scope), for what the app does as them (DESIGN.md §19.3):
   * the token is kept sealed (`src/sovereign/tokens.ts`) and the invitations made for that `sub` are taken (`src/invitations/`). After it returns, **the sign-in store's own copy of the token is cleared**, so that a
   * credential is in one place. A failure here does not undo the sign-in: it is logged by kind, and the next sign-in tries again.
   */
  onSovereignSignIn?:
    | ((info: {
        accountId: string;
        sub: string;
        refreshToken: string | undefined;
      }) => Promise<void>)
    | undefined;
}

/** The prefix of better-auth's cookies, so that ours do not collide with another app's on localhost. */
export const COOKIE_PREFIX = 'waymark';

/**
 * How recently a session must have been made for the things that ask for a fresh one: unlinking Sovereign here, and deleting an account that has no password
 * to ask for. Ten minutes: long enough to do them after signing in, short enough that a session left open is not enough.
 */
export const FRESH_SESSION_SECONDS = 10 * 60;

/**
 * The paths that set up a password's second factor or a passkey. An account that has no password (it came in through Sovereign alone) has neither: Sovereign
 * has its own (DESIGN.md §19.1). The pages do not show them, and these refuse, so that the page is not the only thing that says so.
 */
const FOR_PASSWORD_ACCOUNTS = [
  '/two-factor/enable',
  '/two-factor/get-totp-uri',
  '/two-factor/generate-backup-codes',
  '/passkey/generate-register-options',
  '/passkey/verify-registration',
];

/** The invitation's token a sign-up carries, if it does: the header of the request the account is being made by. */
function tokenOf(context: unknown): string | undefined {
  const ctx = context as { request?: Request; headers?: Headers } | null;
  const value = ctx?.request?.headers.get(INVITE_HEADER) ?? ctx?.headers?.get(INVITE_HEADER);
  return value && value.length <= 200 ? value : undefined;
}

export function createAuth({
  settings,
  name,
  database,
  mailer,
  onAccountCreated,
  onSovereignSignIn,
  invitationOpen,
}: AuthDependencies) {
  const schema = database.dialect === 'postgres' ? postgresAuth : sqliteAuth;
  const { local, sovereign } = settings;
  // Mail is for the password's account: an address is verified, and a password reset, only where there is a password.
  const mail = local ? mailer : undefined;

  return betterAuth({
    appName: name,
    secret: settings.secret,
    baseURL: settings.url,
    trustedOrigins: [settings.url],
    database: drizzleAdapter(database.db, {
      provider: database.dialect === 'postgres' ? 'pg' : 'sqlite',
      schema,
    }),
    // Without email (task 2.3) there is nothing to verify an address with, so sign-up is immediate and signs the person in.
    emailAndPassword: {
      enabled: local,
      minPasswordLength: settings.passwordMinLength,
      // With mail, a new account is signed in by the link it is sent and not before; without it, at once.
      autoSignIn: mail === undefined,
      requireEmailVerification: mail !== undefined,
      ...(mail
        ? {
            // A reset link is good once and for an hour, and using it ends every session of the account.
            resetPasswordTokenExpiresIn: 60 * 60,
            revokeSessionsOnPasswordReset: true,
            sendResetPassword: async ({ user, url }: { user: { email: string }; url: string }) => {
              // Not awaited by the request (a slow mail server would tell a visitor which addresses have accounts by how long it takes) and a failure is not told to them.
              void mail.send(resetMessage(name, user.email, url)).catch(() => undefined);
            },
          }
        : {}),
    },
    ...(mail
      ? {
          emailVerification: {
            sendOnSignUp: true,
            sendOnSignIn: true,
            autoSignInAfterVerification: true,
            sendVerificationEmail: async ({
              user,
              url,
            }: {
              user: { email: string };
              url: string;
            }) => {
              void mail.send(verificationMessage(name, user.email, url)).catch(() => undefined);
            },
          },
        }
      : {}),
    account: {
      // A Sovereign login is matched to an account by its `sub`, never by an email address that happens to be a local account's (DESIGN.md §19.1). The two are
      // linked from a signed-in session (task 2.6), by someone who has shown they control both, and only when core's address is the account's own: a link that
      // came with another address would be a way to attach someone else's identity to this account. Until then a Sovereign login whose address is a local
      // account's is refused (`account_not_linked`).
      accountLinking: {
        disableImplicitLinking: true,
        allowDifferentEmails: false,
        // Unlinking can never leave an account with no way to sign in: its last one stays.
        allowUnlinkingAll: false,
        // Sovereign's contract is that `email` is verified, which is what linking asks of a provider.
        ...(sovereign ? { trustedProviders: [SOVEREIGN_PROVIDER_ID] } : {}),
      },
      // What core hands over is not used after sign-in; what is kept is kept encrypted.
      encryptOAuthTokens: true,
    },
    // A session is fresh for ten minutes (`FRESH_SESSION_SECONDS`), for the few things that ask for it.
    session: { freshAge: FRESH_SESSION_SECONDS },
    hooks: {
      after: createAuthMiddleware(async (ctx) => {
        // A sign-in through core has ended (the callback of the Sovereign provider): what the app keeps of it for the person is made here, once the account and its session are.
        if (!sovereign || !onSovereignSignIn) return;
        if (ctx.path !== '/callback/:id' || ctx.params?.id !== SOVEREIGN_PROVIDER_ID) return;
        const accountId = ctx.context.newSession?.user.id;
        if (!accountId) return;
        try {
          const accounts = await ctx.context.internalAdapter.findAccounts(accountId);
          const account = accounts.find((each) => each.providerId === SOVEREIGN_PROVIDER_ID);
          if (!account) return;
          const refreshToken = account.refreshToken
            ? await decryptOAuthToken(account.refreshToken, ctx.context)
            : undefined;
          await onSovereignSignIn({ accountId, sub: account.accountId, refreshToken });
          // Moved, not copied: only once it has been kept elsewhere is the sign-in store's copy cleared.
          if (account.refreshToken)
            await ctx.context.internalAdapter.updateAccount(account.id, { refreshToken: null });
        } catch (error) {
          // The kind and nothing else: a message can hold a token or an address.
          console.error(
            `[waymark] a sign-in through core was not finished: ${error instanceof Error ? error.name : typeof error}`,
          );
        }
      }),
      before: createAuthMiddleware(async (ctx) => {
        if (!FOR_PASSWORD_ACCOUNTS.includes(ctx.path)) return;
        const session = await getSessionFromCtx(ctx);
        if (!session) return; // the route says so itself
        const accounts = await ctx.context.internalAdapter.findAccounts(session.user.id);
        if (accounts.some((account) => account.providerId === 'credential')) return;
        throw new APIError('FORBIDDEN', {
          message: 'This account signs in through Sovereign, which has its own.',
          code: 'NO_PASSWORD_ACCOUNT',
        });
      }),
    },
    // Counted in the database, not in memory, so that a limit holds across every process.
    rateLimit: { enabled: true, storage: 'database' },
    advanced: {
      cookiePrefix: COOKIE_PREFIX,
      useSecureCookies: settings.url.startsWith('https:'),
      // better-auth skips its origin check when NODE_ENV is "test", which would let a test pass on behaviour production does not have. Say
      // so, so that the two are the same.
      disableOriginCheck: false,
    },
    databaseHooks: {
      user: {
        create: {
          // One policy for every way an account can come to be (DESIGN.md §19.1), here and not in a route, so that it holds for all of them.
          before: async (_user: unknown, context: unknown) => {
            if (settings.signUp === 'open') return;
            // Anyone a core signs in is let in whatever `WAYMARK_AUTH_SIGNUP` says (DESIGN.md §19.1): the core decides who may sign in to it, and this setting is about who may make a
            // local account. The way in is the callback of the Sovereign provider, which only the OIDC exchange with the core reaches.
            const ctx = context as { path?: string; params?: { id?: string } } | null;
            if (
              sovereign &&
              ctx?.path === '/callback/:id' &&
              ctx.params?.id === SOVEREIGN_PROVIDER_ID
            )
              return;
            // `invite`: the first account, and anyone holding an invitation that can still be used; the token comes in a header, and a token that does not open one is the same refusal as none.
            if (settings.signUp === 'invite' && (await countUsers(database)) > 0) {
              const token = tokenOf(context);
              if (token && (await invitationOpen?.(token))) return;
            }
            if ((await countUsers(database)) > 0) {
              // With a code, so that a refusal can be told apart from any other 403.
              throw new APIError('FORBIDDEN', {
                message: 'Sign-up is closed on this instance.',
                code: SIGNUP_CLOSED,
              });
            }
          },
          after: async (user: { id: string; name: string; email: string }) => {
            try {
              await onAccountCreated?.({ id: user.id, name: user.name, email: user.email });
            } catch (error) {
              // Not the message, which can name an address: the kind, and the profile is made when it is first read.
              console.error(
                `[waymark] a profile was not made for a new account: ${error instanceof Error ? error.name : typeof error}`,
              );
            }
          },
        },
      },
    },
    plugins: [
      ...(local
        ? [
            // An authenticator app, with ten single-use backup codes (DESIGN.md §6, §19). It is on for an account only once a code from the app has been shown to work,
            // and turning it off, or making new backup codes, asks for the password again.
            twoFactor({ issuer: name }),
            // Passkeys, which can sign in with no password. The relying party is the address people use (`WAYMARK_URL`): a passkey made here works here and nowhere else.
            passkey({ rpID: new URL(settings.url).hostname, rpName: name, origin: settings.url }),
          ]
        : []),
      ...(sovereign
        ? [
            genericOAuth({
              config: [
                {
                  providerId: SOVEREIGN_PROVIDER_ID,
                  discoveryUrl: `${sovereign.issuer}/.well-known/openid-configuration`,
                  // The profile comes from the ID token, so this refuses to run on one that cannot be checked against the issuer's keys: a discovery
                  // document without them is not a reason to trust whatever the token endpoint says.
                  requireIdTokenVerification: true,
                  clientId: sovereign.clientId,
                  clientSecret: sovereign.clientSecret,
                  authentication: 'basic',
                  scopes: SOVEREIGN_SCOPES,
                  pkce: true,
                  // Signing out of Waymark does not sign the person out of core, which is their account for other things as well.
                  disableProviderLogout: true,
                  // Core's contract is `sub`, `email` and `name`; a missing name is not a reason to refuse.
                  mapProfileToUser: (profile: Record<string, unknown>) => ({
                    name:
                      typeof profile.name === 'string' && profile.name.trim() !== ''
                        ? profile.name
                        : String(profile.email ?? '').split('@')[0] || 'Sovereign user',
                    emailVerified: profile.emailVerified === true,
                  }),
                },
              ],
            }),
          ]
        : []),
      // Must be last: it turns cookies set while handling a Server Action into real ones.
      nextCookies(),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
