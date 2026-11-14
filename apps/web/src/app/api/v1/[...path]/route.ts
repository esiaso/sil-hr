import { NextRequest, NextResponse } from 'next/server';
import { ACCESS_COOKIE, API_URL, CSRF_HEADER, CSRF_VALUE, REFRESH_COOKIE, clearTokenCookies, problemResponse, refreshTokens, setTokenCookies, type TokenSet } from '@/lib/server-session';

/**
 * Transparent reverse proxy from the web origin to the public REST API. It only adds the
 * bearer token from the session cookie (refreshing it when it expires); it cannot reach
 * anything the API does not publish. Non-GET requests must carry the custom header, which
 * a cross-site form cannot set (CSRF defence for cookie-borne tokens).
 */
const FORWARD_REQUEST = ['content-type', 'accept', 'if-match', 'if-none-match', 'idempotency-key', 'x-correlation-id'];
const FORWARD_RESPONSE = ['content-type', 'etag', 'x-correlation-id', 'retry-after', 'idempotent-replayed', 'content-disposition'];

async function forward(req: NextRequest, path: string[], token: string | undefined, body: ArrayBuffer | undefined): Promise<Response> {
  const headers = new Headers();
  for (const h of FORWARD_REQUEST) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  if (token) headers.set('authorization', `Bearer ${token}`);
  const forwardedFor = req.headers.get('x-forwarded-for');
  if (forwardedFor) headers.set('x-forwarded-for', forwardedFor);
  headers.set('user-agent', req.headers.get('user-agent') ?? 'sil-hr-web');
  return fetch(`${API_URL}/api/v1/${path.map(encodeURIComponent).join('/')}${req.nextUrl.search}`, { method: req.method, headers, body, cache: 'no-store', redirect: 'manual' });
}

async function handle(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }): Promise<NextResponse> {
  const { path } = await ctx.params;
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.get(CSRF_HEADER) !== CSRF_VALUE) {
    return problemResponse(403, 'csrf', `Send the ${CSRF_HEADER} header`);
  }
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer();
  let token = req.cookies.get(ACCESS_COOKIE)?.value;
  const refresh = req.cookies.get(REFRESH_COOKIE)?.value;
  let refreshed: TokenSet | null = null;

  if (!token && refresh) {
    refreshed = await refreshTokens(refresh);
    token = refreshed?.access_token;
  }
  let upstream = await forward(req, path, token, body);
  if (upstream.status === 401 && refresh && !refreshed) {
    refreshed = await refreshTokens(refresh);
    if (refreshed) upstream = await forward(req, path, refreshed.access_token, body);
  }

  const res = new NextResponse(upstream.status === 204 || upstream.status === 304 ? null : await upstream.arrayBuffer(), { status: upstream.status });
  for (const h of FORWARD_RESPONSE) {
    const v = upstream.headers.get(h);
    if (v) res.headers.set(h, v);
  }
  if (refreshed) setTokenCookies(res, refreshed);
  else if (upstream.status === 401 && refresh) clearTokenCookies(res);
  return res;
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
