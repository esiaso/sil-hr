'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { loginRequest } from '@sil/hr-shared';
import { Button, Field, Input, ProblemBanner } from '@/components/ui';
import { authPost } from '@/lib/api';
import { usePublicSettings } from '@/lib/session';

const mfaForm = z.object({ code: z.string().trim().min(6, 'Enter the 6-digit code or a recovery code').max(20) });

function LoginForm() {
  const router = useRouter();
  const next = useSearchParams().get('next') ?? '/';
  const settings = usePublicSettings();
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const creds = useForm<z.infer<typeof loginRequest>>({ resolver: zodResolver(loginRequest) });
  const mfa = useForm<z.infer<typeof mfaForm>>({ resolver: zodResolver(mfaForm) });

  const finish = (r: { must_change_password?: boolean }) => router.replace(r.must_change_password ? '/account?change=1' : next.startsWith('/') && !next.startsWith('//') ? next : '/');

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="surface w-full max-w-sm rounded-lg p-6 shadow-sm">
        <h1 className="text-xl font-semibold">
          <span className="text-brand-600">SIL</span> HR
        </h1>
        <p className="muted mb-5 text-sm">{settings.data?.organisation_name ?? 'Sign in'}</p>
        <ProblemBanner error={error} />
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
