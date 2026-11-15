import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Providers } from '@/lib/session';
import './globals.css';

export const metadata: Metadata = { title: { default: 'SIL HR', template: '%s · SIL HR' }, description: 'Human resources and payroll' };
export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

/** Sets the theme before the first paint: the saved choice, else the system setting. */
const THEME_SCRIPT = `try{var t=localStorage.getItem('silhr-theme');if(t!=='light'&&t!=='dark')t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-screen antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
