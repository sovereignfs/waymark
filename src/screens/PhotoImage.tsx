'use client';

import { useEffect, useState } from 'react';
import { useLocal } from '../local/LocalProvider';
import { thumbIdAsync } from '../media/thumb';
import styles from './Timeline.module.css';

/**
 * A photo of a check-in (DESIGN.md §9.3, §15.6): **from the device while it is only there** (a photo taken offline, shown at once from its file), and from the server through `/api/media` otherwise, the
 * thumbnail in a list and the full image where it is the point. A photo whose file has not reached the server yet is a **placeholder**, tried again when a sync has gone by, never a broken image.
 */
export function PhotoImage({ id, thumb, alt }: { id: string; thumb?: boolean; alt: string }) {
  const local = useLocal();
  const [src, setSrc] = useState<string | undefined>();
  const [failed, setFailed] = useState(false);
  const state = local?.state;

  useEffect(() => {
    let alive = true;
    setFailed(false);
    void (async () => {
      const device = await local?.photoSrc(id);
      if (!alive) return;
      if (device?.startsWith('blob:')) return setSrc(device);
      setSrc(
        thumb ? `/api/media/${await thumbIdAsync(id)}` : `/api/media/${encodeURIComponent(id)}`,
      );
    })();
    return () => {
      alive = false;
    };
    // After each sync (`state`): a photo that was not there a moment ago may be now.
  }, [id, thumb, local, state]);

  if (!src || failed)
    return <span className={styles.placeholder} role="img" aria-label={`${alt}: not here yet`} />;
  return (
    <img
      className={styles.image}
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}
