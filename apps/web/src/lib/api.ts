'use client';

import { createHrClient } from '@sil/hr-shared/client';
import type { Problem } from '@sil/hr-shared';

/**
 * The generated, typed client for the public API, pointed at the same-origin proxy.
 * Every request carries the CSRF header the proxy requires for writes.
 */
export const hr = createHrClient({
  baseUrl: typeof window === 'undefined' ? 'http://localhost' : window.location.origin,
  headers: { 'x-requested-with': 'sil-hr-web' },
});

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: Partial<Problem> & Record<string, unknown>,
  ) {
    super(problem.detail ?? problem.title ?? `Request failed (${status})`);
  }

  /** Field errors keyed by path, for react-hook-form's setError. */
  get fieldErrors(): Record<string, string> {
    return Object.fromEntries((this.problem.errors ?? []).map((e) => [e.path, e.message]));
  }
}

type Result<T> = { data?: T; error?: unknown; response: Response };

/** Resolves to the data or throws ApiError (with the RFC 9457 problem). Redirects to login on 401. */
export async function unwrap<T>(p: Promise<Result<T>>): Promise<T> {
  const { data, error, response } = await p;
  if (response.ok) return data as T;
  if (response.status === 401 && typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
  }
  throw new ApiError(response.status, (error ?? {}) as Partial<Problem>);
}

/** Same, but also returns the ETag for a following If-Match. */
export async function withEtag<T>(p: Promise<Result<T>>): Promise<{ data: T; etag: string }> {
  const r = await p;
  const data = await unwrap(Promise.resolve(r));
  return { data, etag: r.response.headers.get('etag') ?? '' };
}

/** Plain fetch for the web app's own /auth route handlers (login, MFA, logout). */
export async function authPost<T>(path: '/auth/login' | '/auth/mfa' | '/auth/logout', body?: unknown): Promise<T> {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'sil-hr-web' }, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 204) return undefined as T;
  const json = await res.json();
  if (!res.ok) throw new ApiError(res.status, json);
  return json as T;
}

export const newIdempotencyKey = () => `web-${crypto.randomUUID()}`;
