import { NextRequest, NextResponse } from 'next/server';
import { API_URL, CSRF_HEADER, CSRF_VALUE, problemResponse, setTokenCookies } from '@/lib/server-session';

/** Second factor: calls POST /api/v1/auth/mfa/verify. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  if (req.headers.get(CSRF_HEADER) !== CSRF_VALUE) return problemResponse(403, 'csrf', 'Missing header');
  const upstream = await fetch(`${API_URL}/api/v1/auth/mfa/verify`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': req.headers.get('user-agent') ?? 'sil-hr-web' }, body: await req.text(), cache: 'no-store' });
  const body = await upstream.json();
  if (!upstream.ok) return NextResponse.json(body, { status: upstream.status, headers: { 'content-type': 'application/problem+json' } });
  const res = NextResponse.json({ mfa_required: false, must_change_password: body.must_change_password });
  setTokenCookies(res, body);
  return res;
}
