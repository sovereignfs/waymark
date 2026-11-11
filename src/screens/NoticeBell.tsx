'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Icon, NotificationsPanel } from '@sovereignfs/ui';
import { ago } from '../notices/present';
import { useNotices } from './NoticesProvider';

/**
 * The bell at the right of the header (DESIGN.md §17.1, §20.2): the unread count (up to "99+"), the newest notices, each opening where it points and marking itself read, and *Mark all read*. A notice has no
 * dismiss of its own (they go by themselves after 90 days), so the panel's dismiss button marks it read. Online only; with no network it shows what it last had.
 */
export function NoticeBell() {
  const { notices, unread, read, readAll } = useNotices();
  const router = useRouter();
  // The time is read once on the client after it has mounted, so that the server and the first paint agree.
  const [now, setNow] = useState<number | undefined>(undefined);
  useEffect(() => setNow(Date.now()), [notices]);

  return (
    <NotificationsPanel
      aria-label="Notifications"
      align="right"
      unreadCount={unread}
      onMarkAllRead={readAll}
      viewAllHref="/notifications"
      emptyMessage="Nothing yet. What Waymark tells you will be here."
      items={notices.slice(0, 20).map((notice) => ({
        id: notice.id,
        icon: <Icon name="bell" aria-hidden />,
        title: notice.title,
        timeLabel: now === undefined ? '' : ago(notice.at, now),
        read: notice.read,
        ...(notice.href ? { href: notice.href } : {}),
        onOpen: () => {
          read([notice.id]);
          if (notice.href) router.push(notice.href);
        },
        onDismiss: () => read([notice.id]),
      }))}
    />
  );
}
