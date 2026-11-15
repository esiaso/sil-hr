import { NextRequest, NextResponse } from 'next/server';
import { API_URL, setTokenCookies } from '@/lib/server-session';

const WEB_URL = (process.env.WEB_PUBLIC_URL ?? 'http://localhost:3320').replace(/\/$/, '');

/** The identity provider returns here; the API verifies the code and HR's own tokens go into cookies. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const code = req.nextUrl.searchParams.get('code');
  const state = req.nextUrl.searchParams.get('state');
  if (!code || !state) return NextResponse.redirect(`${WEB_URL}/login?sso_error=cancelled`);
  const res = await fetch(`${API_URL}/api/v1/auth/oidc/callback`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': req.headers.get('user-agent') ?? 'sil-hr-web' }, body: JSON.stringify({ code, state }), cache: 'no-store' });
  const body = await res.json();
  if (!res.ok) return NextResponse.redirect(`${WEB_URL}/login?sso_error=${encodeURIComponent(body.code ?? 'failed')}`);
  const out = NextResponse.redirect(`${WEB_URL}/`);
  setTokenCookies(out, body);
  return out;
}
