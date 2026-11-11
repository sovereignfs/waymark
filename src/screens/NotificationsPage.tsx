'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button, EmptyState, Icon } from '@sovereignfs/ui';
import { ago, groupByDay } from '../notices/present';
import { goTo } from './checkin-location';
import { useNotices } from './NoticesProvider';
import styles from './Notifications.module.css';

/**
 * `/notifications` (DESIGN.md §17.1, §20.3): everything a person was told, by day, newest first, each opening where it points and marking itself read, with *Mark all read*. The same copy as the bell's.
 */
export function NotificationsPage() {
  const { notices, unread, status, read, readAll } = useNotices();
  const [now, setNow] = useState<number | undefined>(undefined);
  useEffect(() => setNow(Date.now()), [notices]);
  const zone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const days = useMemo(
    () => (now === undefined ? [] : groupByDay(notices, now, zone)),
    [notices, now, zone],
  );

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <h1>Notifications</h1>
        <Button type="button" variant="secondary" disabled={unread === 0} onClick={readAll}>
          Mark all read
        </Button>
      </div>
      {status === 'loading' ? (
        <p className={styles.muted} role="status">
          Loading…
        </p>
      ) : notices.length === 0 ? (
        <EmptyState
          icon="bell"
          heading={status === 'failed' ? 'Notifications need a connection' : 'Nothing yet'}
          description={
            status === 'failed'
              ? 'Try again when you are back online.'
              : 'What Waymark tells you, such as an import that finished, will be here for 90 days.'
          }
        />
      ) : (
        days.map((day) => (
          <section key={day.date} aria-label={day.label}>
            <h2 className={styles.day}>{day.label}</h2>
            <ul className={styles.list}>
              {day.notices.map((notice) => (
                <li key={notice.id} className={notice.read ? styles.read : styles.unread}>
                  <Icon name="bell" aria-hidden />
                  <span className={styles.body}>
                    {notice.href ? (
                      <a
                        href={notice.href}
                        onClick={(event) => {
                          read([notice.id]);
                          if (
                            !event.defaultPrevented &&
                            event.button === 0 &&
                            !event.metaKey &&
                            !event.ctrlKey &&
                            !event.shiftKey &&
                            !event.altKey &&
                            goTo(notice.href ?? '')
                          )
                            event.preventDefault();
                        }}
                      >
                        {notice.title}
                      </a>
                    ) : (
                      <span>{notice.title}</span>
                    )}
                    {notice.detail ? <span className={styles.muted}>{notice.detail}</span> : null}
                  </span>
                  <span className={styles.muted}>
                    {now === undefined ? '' : ago(notice.at, now)}
                  </span>
                  {notice.read ? null : <span className={styles.dot} aria-label="Unread" />}
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
