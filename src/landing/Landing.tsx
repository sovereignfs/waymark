import { authSettings, signUpAvailable } from '../auth/server';
import { ButtonLink } from '@sovereignfs/ui';
import { landing } from './content';
import styles from './Landing.module.css';

/**
 * The front address for someone who is not signed in (DESIGN.md §20.3). A server component with no client code in it: it is HTML and CSS, so it
 * reads the same before any script runs and with none. Sign-up is offered only where the server would take it (the first account, or an open
 * instance), and sign-in only where it is set up at all.
 */
export async function Landing() {
  const signIn = authSettings() !== undefined;
  const signUp = signIn && (await signUpAvailable());
  return (
    <main className={styles.page}>
      <div className={styles.column}>
        <h1 className={styles.heading}>{landing.heading}</h1>
        <p className={styles.lead}>{landing.lead}</p>

        {signIn ? (
          <div className={styles.actions}>
            <ButtonLink href="/sign-in">{landing.signIn}</ButtonLink>
            {signUp ? (
              <ButtonLink href="/sign-up" variant="secondary">
                {landing.signUp}
              </ButtonLink>
            ) : null}
          </div>
        ) : (
          <p className={styles.note}>{landing.noSignIn}</p>
        )}

        <ul className={styles.features}>
          {landing.features.map((feature) => (
            <li key={feature.title} className={styles.feature}>
              <h2 className={styles.featureTitle}>{feature.title}</h2>
              <p className={styles.featureBody}>{feature.body}</p>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}
