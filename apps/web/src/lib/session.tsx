'use client';

import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { createContext, useContext, useState, type ReactNode } from 'react';
import type { Me, PublicSettings } from '@sil/hr-shared';
import { ApiError, hr, unwrap } from './api';

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 30_000, retry: (n, err) => !(err instanceof ApiError && err.status < 500) && n < 2, refetchOnWindowFocus: false },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

interface SessionValue {
  me: Me;
  settings: PublicSettings;
  can: (...permissions: string[]) => boolean;
}

const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const s = useContext(SessionContext);
  if (!s) throw new Error('useSession outside SessionProvider');
  return s;
}

export function usePublicSettings() {
  return useQuery({ queryKey: ['settings', 'public'], queryFn: () => unwrap(hr.GET('/api/v1/settings/public')) as Promise<PublicSettings>, staleTime: 300_000 });
}

/** Loads /auth/me; while it loads the app shows a skeleton; 401 sends to /login. */
export function SessionProvider({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
  const me = useQuery({ queryKey: ['me'], queryFn: () => unwrap(hr.GET('/api/v1/auth/me')) as Promise<Me> });
  const settings = usePublicSettings();
  if (!me.data || !settings.data) return <>{fallback}</>;
  const held = new Set(me.data.permissions);
  const value: SessionValue = { me: me.data, settings: settings.data, can: (...p) => p.every((x) => held.has(x)) };
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
