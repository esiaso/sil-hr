'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Badge, Button, Card, Field, Input, PageHeader, ProblemBanner } from '@/components/ui';
import { ApiError, hr, unwrap } from '@/lib/api';
import { useSession } from '@/lib/session';

const passwordForm = z
  .object({ current_password: z.string().min(1, 'Required'), new_password: z.string().min(1, 'Required'), confirm: z.string() })
  .refine((v) => v.new_password === v.confirm, { path: ['confirm'], message: 'Does not match' });

function Account() {
  const { me, settings } = useSession();
  const forced = useSearchParams().get('change') === '1' || me.must_change_password;
  const qc = useQueryClient();
  const [done, setDone] = useState(false);
  const pw = useForm<z.infer<typeof passwordForm>>({ resolver: zodResolver(passwordForm) });
  const [pwError, setPwError] = useState<unknown>(null);
  const [enrol, setEnrol] = useState<{ secret: string; qr_data_url: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [mfaError, setMfaError] = useState<unknown>(null);
  const [code, setCode] = useState('');
  const policy = settings.password_policy;

  return (
    <div className="max-w-2xl space-y-5">
      <PageHeader title="My account" description={`${me.display_name} · ${me.username}`} />
      {forced && !done && <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:bg-amber-950/40">Choose a new password before you continue.</div>}
      <Card>
        <h2 className="mb-3 font-semibold">Password</h2>
        <ProblemBanner error={pwError} />
        {done && <p className="mb-3 text-sm text-emerald-700">Password changed.</p>}
        <form
          noValidate
          className="space-y-3"
          onSubmit={pw.handleSubmit(async (v) => {
            setPwError(null);
            try {
              await unwrap(hr.POST('/api/v1/auth/password', { body: { current_password: v.current_password, new_password: v.new_password } }));
              setDone(true);
              pw.reset();
              await qc.invalidateQueries({ queryKey: ['me'] });
            } catch (e) {
              setPwError(e);
              if (e instanceof ApiError && e.fieldErrors.password) pw.setError('new_password', { message: e.fieldErrors.password });
            }
          })}
        >
          <Field label="Current password" htmlFor="cur" error={pw.formState.errors.current_password?.message}>
            <Input id="cur" type="password" autoComplete="current-password" {...pw.register('current_password')} />
          </Field>
          <Field label="New password" htmlFor="new" error={pw.formState.errors.new_password?.message} hint={`At least ${policy.min_length} characters${policy.require_upper ? ', an upper-case letter' : ''}${policy.require_lower ? ', a lower-case letter' : ''}${policy.require_digit ? ', a digit' : ''}${policy.require_symbol ? ', a symbol' : ''}.`}>
            <Input id="new" type="password" autoComplete="new-password" {...pw.register('new_password')} />
          </Field>
          <Field label="Confirm new password" htmlFor="confirm" error={pw.formState.errors.confirm?.message}>
            <Input id="confirm" type="password" autoComplete="new-password" {...pw.register('confirm')} />
          </Field>
          <Button type="submit" busy={pw.formState.isSubmitting}>
            Change password
          </Button>
        </form>
      </Card>

      <Card>
        <h2 className="mb-1 font-semibold">
          Two-factor sign-in <Badge value={me.mfa_enabled ? 'active' : 'inactive'} />
        </h2>
        <p className="muted mb-3 text-sm">An authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…) gives a 6-digit code at each sign-in.</p>
        <ProblemBanner error={mfaError} />
        {codes ? (
          <div className="text-sm">
            <p className="mb-2 font-medium">Save these recovery codes somewhere safe. Each works once if you lose your phone.</p>
            <ul className="grid grid-cols-2 gap-1 font-mono">
              {codes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </div>
        ) : me.mfa_enabled ? (
          <Button
            variant="secondary"
            onClick={async () => {
              const password = window.prompt('Enter your password to turn off two-factor sign-in');
              if (!password) return;
              try {
                await unwrap(hr.POST('/api/v1/auth/mfa/disable', { body: { password } }));
                await qc.invalidateQueries({ queryKey: ['me'] });
              } catch (e) {
                setMfaError(e);
              }
            }}
          >
            Turn off
          </Button>
        ) : enrol ? (
          <div className="space-y-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={enrol.qr_data_url} alt="QR code to scan with your authenticator app" className="h-44 w-44 rounded bg-white p-2" />
            <p className="muted text-xs">
              Or enter this key: <code>{enrol.secret}</code>
            </p>
            <Field label="Code from the app" htmlFor="totp">
              <Input id="totp" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} className="max-w-40" />
            </Field>
            <Button
              onClick={async () => {
                setMfaError(null);
                try {
                  const r = await unwrap(hr.POST('/api/v1/auth/mfa/confirm', { body: { code } }));
                  setCodes(r.recovery_codes);
                  await qc.invalidateQueries({ queryKey: ['me'] });
                } catch (e) {
                  setMfaError(e);
                }
              }}
            >
              Confirm
            </Button>
          </div>
        ) : (
          <Button
            onClick={async () => {
              setMfaError(null);
              try {
                setEnrol(await unwrap(hr.POST('/api/v1/auth/mfa/enrol')));
              } catch (e) {
                setMfaError(e);
              }
            }}
          >
            Set up
          </Button>
        )}
      </Card>

      <Card>
        <h2 className="mb-2 font-semibold">Roles</h2>
        <ul className="text-sm">
          {me.roles.map((r, i) => (
            <li key={i}>
              {r.name} <span className="muted">({r.scope.replace('_', ' ')})</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

export default function AccountPage() {
  return (
    <Suspense>
      <Account />
    </Suspense>
  );
}
