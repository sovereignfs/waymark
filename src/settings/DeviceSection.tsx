'use client';

import { useState } from 'react';
import { Button, ConfirmDialog } from '@sovereignfs/ui';
import { describeMutation } from '../local/describe';
import { useLocal } from '../local/LocalProvider';
import styles from './Settings.module.css';

/**
 * Settings, This device (DESIGN.md §15.5, §21): **Couldn't sync**, which is what the server would not take. A refused change is never thrown away: it is here with the reason in a sentence, and the person
 * sends it again (when what stopped it is mended) or discards it, and only they decide. What is only on this device and has not been sent yet is counted.
 */
export function DeviceSection() {
  const local = useLocal();
  const [discarding, setDiscarding] = useState<string | undefined>();
  if (!local)
    return (
      <div className={styles.group}>
        <h2>This device</h2>
        <p className={styles.hint}>
          This browser keeps nothing of your check-ins, so there is nothing to send from here.
        </p>
      </div>
    );
  const names = local.places.map((place) => ({ id: place.id, name: place.name }));
  return (
    <>
      <div className={styles.group}>
        <h2>Couldn’t sync</h2>
        {local.refused.length === 0 ? (
          <p className={styles.hint}>Everything on this device has been taken by the server.</p>
        ) : (
          <>
            <p className={styles.hint}>
              The server would not take{' '}
              {local.refused.length === 1 ? 'this change' : 'these changes'}. Nothing here is lost
              until you discard it.
            </p>
            <ul className={styles.devices} aria-label="Changes that could not sync">
              {local.refused.map((each) => (
                <li key={each.mutationId} className={styles.device}>
                  <div>
                    <span className={styles.deviceName}>
                      {describeMutation(each.mutation, names)}
                    </span>
                    <span className={styles.hint}>{each.sentence}</span>
                  </div>
                  <span className={styles.row}>
                    <Button variant="secondary" onClick={() => void local.retry(each.mutationId)}>
                      Send again
                    </Button>
                    <Button variant="secondary" onClick={() => setDiscarding(each.mutationId)}>
                      Discard
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      <ConfirmDialog
        open={discarding !== undefined}
        onClose={() => setDiscarding(undefined)}
        onConfirm={() => {
          const id = discarding;
          setDiscarding(undefined);
          if (id) void local.discard(id);
        }}
        title="Discard this change?"
        message="It was never taken by the server, and discarding it removes it from this device for good."
        confirmLabel="Discard"
        cancelLabel="Keep it"
        destructive
      />
    </>
  );
}
