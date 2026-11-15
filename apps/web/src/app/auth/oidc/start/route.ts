import { NextResponse } from 'next/server';
import { API_URL } from '@/lib/server-session';

const WEB_URL = (process.env.WEB_PUBLIC_URL ?? 'http://localhost:3320').replace(/\/$/, '');

/** Starts single sign-on: asks the API for the identity provider URL and sends the browser there. */
export async function GET(): Promise<NextResponse> {
  const res = await fetch(`${API_URL}/api/v1/auth/oidc/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uri: `${WEB_URL}/auth/oidc/callback` }), cache: 'no-store' });
  if (!res.ok) return NextResponse.redirect(`${WEB_URL}/login?sso_error=unavailable`);
  const { authorization_url } = (await res.json()) as { authorization_url: string };
  return NextResponse.redirect(authorization_url);
}
