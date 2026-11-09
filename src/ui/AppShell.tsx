import type { ReactNode } from 'react';
import styles from './AppShell.module.css';

/**
 * The frame of a signed-in page (DESIGN.md §20.2): a header row and the main area. In the header, the sidebar's button and the app's wordmark,
 * _waymark._, on the left (the pin is for the places that have room for it: sign-in, the icons), and on the right the notification bell and the person's
 * avatar menu. The main area is given its columns by the page.
 *
 * It is made here, and not with the design system's `Header` (whose launcher, bell and menu are optional since 0.92, with a `leading` slot for the
 * sidebar's button), because that header always draws a brand badge, an initial on the accent colour, where Waymark's header has only its wordmark, as
 * Tusk's. **Worth offering to `@sovereignfs/ui`:** a `Header` whose brand can be the app's own mark; then this row is that `Header`.
 *
 * The bell and the account menu are given, because what they do (read notices, open settings, sign out) is the notice store's and the auth client's,
 * which this component does not know. Either may be left out until there is one to show (12.1, 2.7).
 */
export function AppShell({
  name,
  toolbar,
  bell,
  account,
  footer,
  children,
}: {
  /** The app's name, which a screen reader says for the wordmark. */
  name: string;
  /** What goes before the wordmark: the sidebar's button. */
  toolbar?: ReactNode;
  /** The notification bell, at the right of the header (12.1). */
  bell?: ReactNode;
  /** The person's avatar menu, at the right of the header (2.7). */
  account?: ReactNode;
  /** The phone's footer (DESIGN.md §20.12): a place for it in the frame, so that adding it changes no route. */
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    // `sv-app-shell` is where the design system's footer publishes its height (`--sv-shell-footer-height`), so that sheets and dialogs clear it.
    <div id="sv-app-shell" className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.lead}>
          {toolbar}
          {/* The wordmark is set in the design system's typeface (a page may not name another, and may not fetch one), heavy and tight; a screen reader says the name. */}
          <a href="/" className={styles.brand} aria-label={name}>
            <span className={styles.wordmark} aria-hidden>
              waymark.
            </span>
          </a>
        </div>
        <div className={styles.actions}>
          {bell}
          {account}
        </div>
      </header>
      <div className={styles.main}>{children}</div>
      {footer ? <footer className={styles.footer}>{footer}</footer> : null}
    </div>
  );
}
