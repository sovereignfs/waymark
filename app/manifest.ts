import type { MetadataRoute } from 'next';
import { site } from '@/src/site';

/** `handle_links` is newer than Next's manifest type, so it is added as a spread, which the type does not check member by member. */
const LINK_CAPTURE = { handle_links: 'preferred' } as const;

/**
 * What a browser reads to install Waymark (DESIGN.md §20.12): a name, an icon of each size it asks for (and one that the platform may cut to its own shape),
 * and `standalone`, so that it opens as an app and not a tab. It opens at `/`, which for someone signed in is Home. The colours are the design system's grey
 * 900 and white.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    // How a browser knows the installed app. It is what a browser derived from `start_url` before it was written here, so existing
    // installs stay the same app: never change it.
    id: '/',
    name: site.name,
    short_name: site.name,
    description: site.description,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    // A link into the app, from Sovereign's launcher or anywhere else, opens the installed app where the device allows it (desktop Chrome
    // and Edge, Android Chrome), on the page it names, in a window already open if there is one (Sovereign research 0010).
    launch_handler: { client_mode: ['navigate-existing', 'auto'] },
    ...LINK_CAPTURE,
    background_color: '#ffffff',
    theme_color: '#18181b',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
