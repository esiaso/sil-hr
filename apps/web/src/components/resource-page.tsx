'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import { ApiError, hr, newIdempotencyKey, unwrap, withEtag } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Badge, Button, Dialog, Empty, Field, Input, LoadMore, Loading, PageHeader, ProblemBanner, Select, Textarea } from './ui';

export interface Column<T> {
  key: string;
  label: string;
  render?: (row: T) => ReactNode;
}

export interface FormField {
  name: string;
  label: string;
  type?: 'text' | 'number' | 'textarea' | 'select' | 'checkbox' | 'email';
  options?: { value: string; label: string }[];
  hint?: string;
  /** Only shown when editing (e.g. status). */
  editOnly?: boolean;
}

export interface ResourceConfig<T extends { id: string }> {
  title: string;
  description: string;
  /** Collection path under /api/v1, e.g. `branches`. */
  path: string;
  managePermission: string;
  columns: Column<T>[];
  fields: FormField[];
  createSchema: z.ZodType;
  updateSchema: z.ZodType;
  /** Values for the edit form from a row. */
  toForm: (row: T) => Record<string, unknown>;
  filters?: ReactNode;
  query?: Record<string, string | undefined>;
  defaultSort?: string;
}

type AnyClient = { GET: (p: string, o?: unknown) => Promise<never>; POST: (p: string, o?: unknown) => Promise<never>; PATCH: (p: string, o?: unknown) => Promise<never> };
const client = hr as unknown as AnyClient;

/** Strips empty strings so optional fields are omitted rather than sent blank. */
function clean(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v === '' ? null : v]).filter(([, v]) => v !== undefined));
}

export function ResourcePage<T extends { id: string; status?: string }>({ config }: { config: ResourceConfig<T> }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [editing, setEditing] = useState<{ row: T | null; etag?: string } | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  const query = useInfiniteQuery({
    queryKey: [config.path, debounced, config.query],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap<{ data: T[]; next_cursor: string | null }>(
        client.GET(`/api/v1/${config.path}`, { params: { query: { limit: 50, search: debounced || undefined, cursor: pageParam, sort: config.defaultSort, ...config.query } } }),
      ),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  const rows = useMemo(() => query.data?.pages.flatMap((p) => p.data) ?? [], [query.data]);
  const canManage = can(config.managePermission);

  return (
    <div>
      <PageHeader title={config.title} description={config.description} actions={canManage && <Button onClick={() => setEditing({ row: null })}>New</Button>} />
      <div className="mb-3 flex flex-wrap gap-2">
        <Input aria-label="Search" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-xs" />
        {config.filters}
      </div>
      <ProblemBanner error={query.error} />
      <div className="surface overflow-x-auto rounded-lg">
        {query.isLoading ? (
          <Loading />
        ) : rows.length === 0 ? (
          <Empty>Nothing here yet.</Empty>
        ) : (
          <table className="data">
            <thead>
              <tr>
                {config.columns.map((c) => (
                  <th key={c.key}>{c.label}</th>
                ))}
                {canManage && <th className="w-16" />}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  {config.columns.map((c) => (
                    <td key={c.key}>{c.render ? c.render(r) : c.key === 'status' ? <Badge value={String(r.status)} /> : String((r as Record<string, unknown>)[c.key] ?? '')}</td>
                  ))}
                  {canManage && (
                    <td>
                      <Button
                        variant="ghost"
                        onClick={async () => {
                          const { data, etag } = await withEtag<T>(client.GET(`/api/v1/${config.path}/{id}`, { params: { path: { id: r.id } } }));
                          setEditing({ row: data, etag });
                        }}
                      >
                        Edit
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <LoadMore hasMore={!!query.hasNextPage} busy={query.isFetchingNextPage} onClick={() => query.fetchNextPage()} />
      {editing && (
        <ResourceForm
          config={config}
          row={editing.row}
          etag={editing.etag}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void qc.invalidateQueries({ queryKey: [config.path] });
            // Names shown in other columns (parent paths, branch, grade) come from the lookups.
            void qc.invalidateQueries({ queryKey: ['lookup'] });
          }}
        />
      )}
    </div>
  );
}

function ResourceForm<T extends { id: string }>({ config, row, etag, onClose, onSaved }: { config: ResourceConfig<T>; row: T | null; etag?: string; onClose: () => void; onSaved: () => void }) {
  const schema = row ? config.updateSchema : config.createSchema;
  const form = useForm<Record<string, unknown>>({ resolver: zodResolver(schema as never), defaultValues: row ? config.toForm(row) : {} });
  const [idempotencyKey] = useState(newIdempotencyKey);
  const save = useMutation({
    mutationFn: (values: Record<string, unknown>) =>
      row
        ? unwrap(client.PATCH(`/api/v1/${config.path}/{id}`, { params: { path: { id: row.id } }, body: clean(values), headers: { 'If-Match': etag } }))
        : unwrap(client.POST(`/api/v1/${config.path}`, { body: clean(values), headers: { 'Idempotency-Key': idempotencyKey } })),
    onSuccess: onSaved,
    onError: (e) => {
      if (e instanceof ApiError) for (const [path, message] of Object.entries(e.fieldErrors)) form.setError(path as never, { message });
    },
  });
  const errors = form.formState.errors as Record<string, { message?: string } | undefined>;

  return (
    <Dialog open title={row ? `Edit ${config.title.replace(/s$/, '').toLowerCase()}` : `New ${config.title.replace(/s$/, '').toLowerCase()}`} onClose={onClose}>
      <ProblemBanner error={save.error} />
      <form noValidate className="space-y-3" onSubmit={form.handleSubmit((v) => save.mutate(v))}>
        {config.fields
          .filter((f) => !f.editOnly || row)
          .map((f) => {
            const id = `f-${f.name}`;
            const reg = form.register(f.name, f.type === 'number' ? { setValueAs: (v) => (v === '' || v === null ? undefined : Number(v)) } : f.type === 'select' ? { setValueAs: (v) => (v === '' ? undefined : v) } : {});
            return (
              <Field key={f.name} label={f.label} htmlFor={id} hint={f.hint} error={errors[f.name]?.message}>
                {f.type === 'textarea' ? (
                  <Textarea id={id} {...reg} />
                ) : f.type === 'select' ? (
                  <Select id={id} {...reg}>
                    <option value="">—</option>
                    {f.options?.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                ) : f.type === 'checkbox' ? (
                  <input id={id} type="checkbox" className="h-4 w-4" {...reg} />
                ) : (
                  <Input id={id} type={f.type === 'number' ? 'number' : f.type === 'email' ? 'email' : 'text'} {...reg} />
                )}
              </Field>
            );
          })}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={save.isPending}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
