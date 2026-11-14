import { NextRequest, NextResponse } from 'next/server';
import { API_URL, CSRF_HEADER, CSRF_VALUE, problemResponse, setTokenCookies } from '@/lib/server-session';

/** Calls the public POST /api/v1/auth/login and keeps the tokens in httpOnly cookies. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  if (req.headers.get(CSRF_HEADER) !== CSRF_VALUE) return problemResponse(403, 'csrf', 'Missing header');
  const upstream = await fetch(`${API_URL}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': req.headers.get('user-agent') ?? 'sil-hr-web', ...(req.headers.get('x-forwarded-for') ? { 'x-forwarded-for': req.headers.get('x-forwarded-for')! } : {}) },
    body: await req.text(),
    cache: 'no-store',
  });
  const body = await upstream.json();
  if (!upstream.ok) return NextResponse.json(body, { status: upstream.status, headers: { 'content-type': 'application/problem+json' } });
  if (body.mfa_required) return NextResponse.json({ mfa_required: true, mfa_token: body.mfa_token });
  const res = NextResponse.json({ mfa_required: false, must_change_password: body.must_change_password });
  setTokenCookies(res, body);
  return res;
}
