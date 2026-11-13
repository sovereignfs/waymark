'use client';

import { useEffect, useState } from 'react';
import { PhotoGallery, type Photo } from '@sovereignfs/ui';
import { useLocal } from '../local/LocalProvider';
import { thumbIdAsync } from '../media/thumb';

/**
 * The photos of a check-in as the design system's gallery (DESIGN.md §9.3, §20.6): a grid of thumbnails opening a full-screen viewer with swipe, keys and zoom. **Each photo is shown from the device while it is only there** (a
 * photo taken with no network: a `blob:` address) **and from the server's `/api/media` otherwise**, the thumbnail in the grid and the whole picture in the viewer, so the viewer asks for no address but the app's own.
 * A photo whose file is on no device here and has not reached the server yet is the browser's missing image until it has: the gallery shows what it is given, and is given a new list after each sync.
 */
export function PhotoGalleryOf({
  ids,
  label = 'Photos',
}: {
  ids: readonly string[];
  label?: string;
}) {
  const local = useLocal();
  const state = local?.state;
  const [photos, setPhotos] = useState<Photo[]>([]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const made: Photo[] = [];
      for (const [index, id] of ids.entries()) {
        const device = await local?.photoSrc(id);
        const onDevice = device?.startsWith('blob:') ? device : undefined;
        made.push({
          id,
          src: onDevice ?? `/api/media/${encodeURIComponent(id)}`,
          thumbSrc: onDevice ?? `/api/media/${await thumbIdAsync(id)}`,
          alt: `Photo ${index + 1} of ${ids.length}`,
        });
      }
      if (alive) setPhotos(made);
    })();
    return () => {
      alive = false;
    };
    // After each sync (`state`): a photo that was not there a moment ago may be now.
  }, [ids, local, state]);

  if (photos.length === 0) return null;
  return <PhotoGallery photos={photos} label={label} />;
}
