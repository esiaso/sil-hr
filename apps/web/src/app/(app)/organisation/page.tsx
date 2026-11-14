'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { updateOrganisation, type UpdateOrganisation } from '@sil/hr-shared';
import { Button, Card, Field, Input, Loading, PageHeader, ProblemBanner, Textarea } from '@/components/ui';
import { ApiError, hr, unwrap, withEtag } from '@/lib/api';
import { useSession } from '@/lib/session';

const FIELDS: { name: keyof UpdateOrganisation; label: string; hint?: string }[] = [
  { name: 'name', label: 'Name' },
  { name: 'legal_name', label: 'Legal name' },
  { name: 'kra_pin', label: 'KRA PIN', hint: 'A or P, 9 digits, a letter' },
  { name: 'nssf_employer_no', label: 'NSSF employer number' },
  { name: 'sha_employer_no', label: 'SHA employer number' },
  { name: 'phone', label: 'Phone' },
  { name: 'email', label: 'Email' },
  { name: 'website', label: 'Website' },
];

export default function OrganisationPage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['organisation'], queryFn: () => withEtag(hr.GET('/api/v1/organisation')) });
  const form = useForm<UpdateOrganisation>({ resolver: zodResolver(updateOrganisation) });
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (q.data) form.reset(Object.fromEntries(Object.entries(q.data.data).map(([k, v]) => [k, v ?? ''])) as UpdateOrganisation);
  }, [q.data, form]);
  if (!q.data) return q.error ? <ProblemBanner error={q.error} /> : <Loading />;
  const readOnly = !can('organisation:update');

  return (
    <div className="max-w-2xl">
      <PageHeader title="Organisation profile" description="The legal entity. Employer numbers are used on statutory returns (payroll slice)." />
      <Card>
        <ProblemBanner error={error} />
        {saved && <p className="mb-3 text-sm text-emerald-700">Saved.</p>}
        <form
          noValidate
          className="space-y-3"
          onSubmit={form.handleSubmit(async (v) => {
            setError(null);
            setSaved(false);
            try {
              const body = Object.fromEntries(Object.entries(v).map(([k, val]) => [k, val === '' ? null : val])) as UpdateOrganisation;
              await unwrap(hr.PATCH('/api/v1/organisation', { params: { header: { 'If-Match': q.data!.etag } }, body }));
              setSaved(true);
              await qc.invalidateQueries({ queryKey: ['organisation'] });
            } catch (e) {
              setError(e);
              if (e instanceof ApiError) for (const [p, m] of Object.entries(e.fieldErrors)) form.setError(p as keyof UpdateOrganisation, { message: m });
            }
          })}
        >
          <fieldset disabled={readOnly} className="space-y-3">
            {FIELDS.map((f) => (
              <Field key={f.name} label={f.label} htmlFor={f.name} hint={f.hint} error={form.formState.errors[f.name]?.message}>
                <Input id={f.name} {...form.register(f.name)} />
              </Field>
            ))}
            <Field label="Address" htmlFor="address">
              <Textarea id="address" {...form.register('address')} />
            </Field>
          </fieldset>
          {!readOnly && (
            <Button type="submit" busy={form.formState.isSubmitting}>
              Save
            </Button>
          )}
        </form>
      </Card>
    </div>
  );
}
