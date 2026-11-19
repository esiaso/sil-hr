import { expect, type Page } from '@playwright/test';
import { API, SINK } from '../playwright.config';

/** Sample-data password of the isolated stack (docker-compose default; test value only). */
export const PASSWORD = process.env.E2E_PASSWORD ?? 'Hospital#Dev2026';
const B = `${API}/api/v1`;

/** Access tokens are cached per user: sign-in is rate limited per address (30 a minute), as in production. */
const cache = new Map<string, string>();
export async function token(username: string, password = PASSWORD): Promise<string> {
  const hit = cache.get(`${username}:${password}`);
  if (hit) return hit;
  const r = await fetch(`${B}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  const j = await r.json();
  if (!r.ok) throw new Error(`login ${username}: ${r.status} ${JSON.stringify(j)}`);
  cache.set(`${username}:${password}`, j.access_token);
  return j.access_token as string;
}

export async function call<T = any>(tok: string, method: string, path: string, body?: unknown, expectOk = true): Promise<{ status: number; body: T }> {
  const r = await fetch(`${B}${path}`, { method, headers: { authorization: `Bearer ${tok}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  const parsed = text ? JSON.parse(text) : undefined;
  if (expectOk && !r.ok) throw new Error(`${method} ${path}: ${r.status} ${text}`);
  return { status: r.status, body: parsed as T };
}

/** Approves every remaining step of a request, each by the first eligible person found. */
export async function approveRest(subjectId: string, people = ['line.manager', 'head.nursing', 'hr.manager', 'finance', 'admin']) {
  for (let guard = 0; guard < 6; guard++) {
    let acted = false;
    for (const p of people) {
      const t = await token(p);
      const task = (await call<{ id: string; subject_id: string }[]>(t, 'GET', '/workflow/inbox')).body.find((x) => x.subject_id === subjectId);
      if (!task) continue;
      if ((await call(t, 'POST', `/workflow/tasks/${task.id}/decision`, { decision: 'approve' }, false)).status === 200) { acted = true; break; }
    }
    if (!acted) return;
  }
}

export async function signIn(page: Page, username: string, password = PASSWORD) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.getByLabel('Username or email').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

/** Waits until the development webhook sink has received a delivery matching the predicate. */
export async function webhook(match: (e: { type: string; subject: string; valid_signature: boolean }) => boolean, timeoutMs = 45_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const seen = (await (await fetch(`${SINK}/hooks`)).json()) as { type: string; subject: string; valid_signature: boolean }[];
    const hit = seen.find(match);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('No matching webhook delivery arrived');
}

export const uniq = () => Math.random().toString(36).slice(2, 7).toUpperCase();
export const isoDay = (d: Date) => d.toISOString().slice(0, 10);
/** The weekday `n` weekdays from today (negative = past), in UTC dates. */
export function weekday(n: number): string {
  const d = new Date();
  let left = Math.abs(n);
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + Math.sign(n));
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) left--;
  }
  return isoDay(d);
}

/** Shared between journeys (they run in order in one worker). */
export const state: { hiredId?: string; hiredName?: string } = {};
