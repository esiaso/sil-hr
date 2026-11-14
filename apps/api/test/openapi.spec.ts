import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildOpenApi } from '../src/bootstrap';
import { catalogue } from '../src/modules/events/events.module';
import { closeApp, testApp } from './helpers';

afterAll(closeApp);

const DOCS = join(__dirname, '..', '..', '..', 'docs');
const OPENAPI = join(DOCS, 'openapi.json');
const EVENTS = join(DOCS, 'events.json');

type Doc = { paths: Record<string, Record<string, { parameters?: { name: string; required?: boolean }[]; requestBody?: unknown }>> };

/**
 * Contract tests. The OpenAPI document and the event catalogue are generated from code
 * and checked in. Any difference fails; `pnpm openapi:update` regenerates them, so a
 * contract change is always a deliberate, reviewed commit. Breaking changes (a removed
 * operation, a new required parameter) are reported by name.
 */
function breakingChanges(before: Doc, after: Doc): string[] {
  const out: string[] = [];
  for (const [path, ops] of Object.entries(before.paths)) {
    for (const [method, op] of Object.entries(ops)) {
      const now = after.paths[path]?.[method];
      if (!now) {
        out.push(`removed ${method.toUpperCase()} ${path}`);
        continue;
      }
      const wasRequired = new Set((op.parameters ?? []).filter((p) => p.required).map((p) => p.name));
      for (const p of now.parameters ?? []) if (p.required && !wasRequired.has(p.name)) out.push(`new required parameter ${p.name} on ${method.toUpperCase()} ${path}`);
    }
  }
  return out;
}

const stable = (v: unknown) => JSON.stringify(v, null, 2) + '\n';

describe('contract snapshots', () => {
  it('OpenAPI document matches docs/openapi.json', async () => {
    const app = await testApp();
    const doc = buildOpenApi(app) as unknown as Doc & { openapi: string };
    expect(doc.openapi).toBe('3.1.0');
    if (process.env.UPDATE_OPENAPI || !existsSync(OPENAPI)) {
      if (existsSync(OPENAPI) && !process.env.ALLOW_BREAKING) {
        const breaking = breakingChanges(JSON.parse(readFileSync(OPENAPI, 'utf8')), doc);
        if (breaking.length) throw new Error(`Breaking API changes (set ALLOW_BREAKING=1 to accept):\n${breaking.join('\n')}`);
      }
      writeFileSync(OPENAPI, stable(doc));
      return;
    }
    const committed = JSON.parse(readFileSync(OPENAPI, 'utf8')) as Doc;
    expect(breakingChanges(committed, doc)).toEqual([]);
    expect(stable(doc)).toBe(stable(committed));
  });

  it('event catalogue matches docs/events.json', () => {
    const current = catalogue();
    if (process.env.UPDATE_OPENAPI || !existsSync(EVENTS)) {
      writeFileSync(EVENTS, stable(current));
      return;
    }
    const committed = JSON.parse(readFileSync(EVENTS, 'utf8')) as { type: string }[];
    // A published event type may never disappear (consumers depend on it).
    const removed = committed.map((e) => e.type).filter((t) => !current.some((c) => c.type === t));
    expect(removed).toEqual([]);
    expect(stable(current)).toBe(stable(committed));
  });
});
