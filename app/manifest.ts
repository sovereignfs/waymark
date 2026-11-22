import { manifest } from '@sovereignfs/pwa';
import { site } from '@/src/site';

/**
 * What a browser reads to install Waymark (DESIGN.md §20.12), made by the suite's `@sovereignfs/pwa`: a window of its own, an icon of each size it asks for (and one
 * that the platform may cut to its own shape), and what lets a link into the app, from Sovereign's launcher or anywhere else, open the installed app
 * where the device allows it (Sovereign research 0010).
 */
export default function webManifest() {
  return manifest({
    name: site.name,
    description: site.description,
    // How a browser knows the installed app. It is what a browser derived from `start_url` before it was written, so existing installs stay the same
    // app: never change it.
    id: '/',
    backgroundColor: '#ffffff',
    themeColor: '#18181b',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  });
}
