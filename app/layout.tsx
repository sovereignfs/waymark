import type { ReactNode } from 'react';
import { site } from '@/src/site';

export const metadata = { title: site.title, description: site.description };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
