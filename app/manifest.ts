import type { MetadataRoute } from 'next';
import { site } from '@/src/site';

/**
 * What a browser reads to install Waymark (DESIGN.md §20.12): a name, an icon of each size it asks for (and one that the platform may cut to its own shape),
 * and `standalone`, so that it opens as an app and not a tab. It opens at `/`, which for someone signed in is Home. The colours are the design system's grey
 * 900 and white.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: site.name,
    short_name: site.name,
    description: site.description,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#18181b',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
