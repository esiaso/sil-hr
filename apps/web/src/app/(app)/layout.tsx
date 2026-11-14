import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { Shell } from '@/components/shell';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '@/lib/server-session';

/** Every page under (app) needs a session; the API remains the authority on each call. */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const jar = await cookies();
  if (!jar.get(ACCESS_COOKIE) && !jar.get(REFRESH_COOKIE)) redirect('/login');
  return <Shell>{children}</Shell>;
}
