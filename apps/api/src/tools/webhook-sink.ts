import { createServer } from 'node:http';
import { verify } from '../modules/webhooks/signing';

/**
 * Development-only webhook receiver (compose service `webhook-sink`). Verifies each
 * delivery's Standard Webhooks signature with WEBHOOK_SINK_SECRET and keeps the last
 * 200 for inspection: GET /hooks returns them as JSON. Also a worked example for
 * developers of consuming systems. Answer 500 on demand: POST /hooks?fail=1.
 */
const secret = process.env.WEBHOOK_SINK_SECRET ?? '';
const port = Number(process.env.WEBHOOK_SINK_PORT ?? 8099);
const seen: { received_at: string; valid_signature: boolean; webhook_id: string; type: string; subject: string; body: unknown }[] = [];
const ids = new Set<string>();

createServer((req, res) => {
  if (req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(seen.slice().reverse(), null, 2));
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const headers = { id: String(req.headers['webhook-id'] ?? ''), timestamp: String(req.headers['webhook-timestamp'] ?? ''), signature: String(req.headers['webhook-signature'] ?? '') };
    const valid = !!secret && verify(secret, headers, body);
    if (!valid) {
      res.writeHead(401).end('bad signature');
      return;
    }
    if (req.url?.includes('fail=1')) {
      res.writeHead(500).end('failing on purpose');
      return;
    }
    // Consumers must de-duplicate: the same webhook-id is re-sent on every retry.
    if (!ids.has(headers.id)) {
      ids.add(headers.id);
      const event = JSON.parse(body);
      seen.push({ received_at: new Date().toISOString(), valid_signature: valid, webhook_id: headers.id, type: event.type, subject: event.subject, body: event });
      if (seen.length > 200) seen.shift();
    }
    res.writeHead(204).end();
  });
}).listen(port, () => console.log(`webhook-sink listening on :${port}`));
