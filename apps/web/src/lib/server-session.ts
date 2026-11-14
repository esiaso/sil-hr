import 'server-only';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

/**
 * The web app is a client of the public API. Tokens live in httpOnly cookies on the web
 * origin; route handlers attach them as bearer tokens. Nothing here is a private API.
 */
export const API_URL = (process.env.HR_API_INTERNAL_URL ?? 'http://localhost:3310').replace(/\/$/, '');
export const ACCESS_COOKIE = 'hr_at';
export const REFRESH_COOKIE = 'hr_rt';
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_VALUE = 'sil-hr-web';

const secure = process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE !== 'false';

export interface TokenSet {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
}

export function setTokenCookies(res: NextResponse, t: TokenSet): void {
  res.cookies.set(ACCESS_COOKIE, t.access_token, { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: t.expires_in });
  if (t.refresh_token) res.cookies.set(REFRESH_COOKIE, t.refresh_token, { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: 14 * 86400 });
}

export function clearTokenCookies(res: NextResponse): void {
  res.cookies.set(ACCESS_COOKIE, '', { path: '/', maxAge: 0 });
  res.cookies.set(REFRESH_COOKIE, '', { path: '/', maxAge: 0 });
}

export async function refreshTokens(refreshToken: string): Promise<TokenSet | null> {
  const res = await fetch(`${API_URL}/api/v1/auth/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refresh_token: refreshToken }), cache: 'no-store' });
  return res.ok ? ((await res.json()) as TokenSet) : null;
}

/** Server components: GET a public API path with the signed-in user's token. */
export async function serverGet<T>(path: string): Promise<{ ok: true; data: T } | { ok: false; status: number; problem: { detail?: string; code?: string } }> {
  const jar = await cookies();
  const token = jar.get(ACCESS_COOKIE)?.value;
  const res = await fetch(`${API_URL}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {}, cache: 'no-store' });
  if (!res.ok) return { ok: false, status: res.status, problem: await res.json().catch(() => ({})) };
  return { ok: true, data: (await res.json()) as T };
}

export function problemResponse(status: number, code: string, detail: string): NextResponse {
  return new NextResponse(JSON.stringify({ type: `urn:sil:hr:problem:${code}`, title: 'Error', status, code, detail }), { status, headers: { 'content-type': 'application/problem+json' } });
}
