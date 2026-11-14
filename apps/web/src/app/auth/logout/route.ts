import { NextRequest, NextResponse } from 'next/server';
import { ACCESS_COOKIE, API_URL, CSRF_HEADER, CSRF_VALUE, REFRESH_COOKIE, clearTokenCookies, problemResponse } from '@/lib/server-session';

/** Ends the session at the API (revokes the refresh-token family) and clears cookies. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  if (req.headers.get(CSRF_HEADER) !== CSRF_VALUE) return problemResponse(403, 'csrf', 'Missing header');
  const token = req.cookies.get(ACCESS_COOKIE)?.value;
  const refresh = req.cookies.get(REFRESH_COOKIE)?.value;
  if (token) {
    await fetch(`${API_URL}/api/v1/auth/logout`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(refresh ? { refresh_token: refresh } : {}), cache: 'no-store' }).catch(() => undefined);
  }
  const res = new NextResponse(null, { status: 204 });
  clearTokenCookies(res);
  return res;
}
