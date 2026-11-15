'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Endorsement, Wordmark } from '@/components/brand';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { BRAND, loginRequest } from '@sil/hr-shared';
import { Button, Field, Input, ProblemBanner } from '@/components/ui';
import { authPost } from '@/lib/api';
import { usePublicSettings } from '@/lib/session';

const mfaForm = z.object({ code: z.string().trim().min(6, 'Enter the 6-digit code or a recovery code').max(20) });

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next') ?? '/';
  const ssoError = params.get('sso_error');
  const sso = useQuery({ queryKey: ['oidc-config'], queryFn: async () => (await fetch('/api/v1/auth/oidc/config')).json() as Promise<{ enabled: boolean; label: string }> });
  const settings = usePublicSettings();
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const creds = useForm<z.infer<typeof loginRequest>>({ resolver: zodResolver(loginRequest) });
  const mfa = useForm<z.infer<typeof mfaForm>>({ resolver: zodResolver(mfaForm) });

  const finish = (r: { must_change_password?: boolean }) => router.replace(r.must_change_password ? '/account?change=1' : next.startsWith('/') && !next.startsWith('//') ? next : '/');

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-[var(--canvas)] p-4">
      <div className="surface w-full max-w-sm rounded-2xl p-8 shadow-[0_8px_30px_rgba(16,24,40,0.08)]">
        <h1 className="mb-1"><Wordmark size="lg" /></h1>
        <p className="muted mb-4 text-xs">{BRAND.tagline}</p>
        <p className="muted mb-5 text-sm">{settings.data?.organisation_name ?? 'Sign in'}</p>
        <ProblemBanner error={error} />
        {ssoError && <ProblemBanner error={new Error(ssoError === 'no_account' ? 'You signed in at the identity provider, but there is no PeopleTrack account for you. Ask HR.' : 'Single sign-on did not complete. Try again or use your password.')} />}
        {sso.data?.enabled && !mfaToken && (
          <>
            <a href="/auth/oidc/start" className="bg-brand-500 hover:bg-brand-600 mb-4 block rounded-lg px-3 py-2.5 text-center text-sm font-medium text-white">{sso.data.label}</a>
            <div className="muted mb-4 text-center text-xs">or with a PeopleTrack password</div>
          </>
        )}
        {!mfaToken ? (
          <form
            noValidate
            className="space-y-4"
            onSubmit={creds.handleSubmit(async (v) => {
              setError(null);
              try {
                const r = await authPost<{ mfa_required: boolean; mfa_token?: string; must_change_password?: boolean }>('/auth/login', v);
                if (r.mfa_required) setMfaToken(r.mfa_token!);
                else finish(r);
              } catch (e) {
                setError(e);
              }
            })}
          >
            <Field label="Username or email" htmlFor="username" error={creds.formState.errors.username?.message}>
              <Input id="username" autoComplete="username" autoFocus {...creds.register('username')} />
            </Field>
            <Field label="Password" htmlFor="password" error={creds.formState.errors.password?.message}>
              <Input id="password" type="password" autoComplete="current-password" {...creds.register('password')} />
            </Field>
            <Button type="submit" className="w-full justify-center" busy={creds.formState.isSubmitting}>
              Sign in
            </Button>
          </form>
        ) : (
          <form
            noValidate
            className="space-y-4"
            onSubmit={mfa.handleSubmit(async (v) => {
              setError(null);
              try {
                finish(await authPost('/auth/mfa', { mfa_token: mfaToken, code: v.code }));
              } catch (e) {
                setError(e);
              }
            })}
          >
            <p className="text-sm">Enter the code from your authenticator app, or one of your recovery codes.</p>
            <Field label="Code" htmlFor="code" error={mfa.formState.errors.code?.message}>
              <Input id="code" inputMode="numeric" autoComplete="one-time-code" autoFocus {...mfa.register('code')} />
            </Field>
            <Button type="submit" className="w-full justify-center" busy={mfa.formState.isSubmitting}>
              Verify
            </Button>
            <button type="button" className="muted w-full text-sm underline" onClick={() => setMfaToken(null)}>
              Start again
            </button>
          </form>
        )}
      </div>
      <footer className="mt-6 text-center"><Endorsement /><div className="muted mt-1 text-[11px]">© {BRAND.company}</div></footer>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
