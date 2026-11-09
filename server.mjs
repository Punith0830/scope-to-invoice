import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compareRecords, createDraft, sandboxToken, verifyDraft } from './services.mjs';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);
const paypalKeys = ['PAYPAL_SANDBOX_CLIENT_ID', 'PAYPAL_SANDBOX_CLIENT_SECRET', 'PAYPAL_SANDBOX_BUYER_EMAIL'];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readJson(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') {
    throw new HttpError(415, 'Use a JSON request.');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 24_000) throw new HttpError(413, 'The records are too long.');
    chunks.push(chunk);
  }
  try {
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    return result;
  } catch {
    throw new HttpError(400, 'Invalid request body.');
  }
}

export function makeServer({ env = process.env, database = fileURLToPath(new URL('./demo.sqlite', import.meta.url)), transport = fetch } = {}) {
  const db = new DatabaseSync(database);
  db.exec("PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS draft (slot INTEGER PRIMARY KEY, value TEXT NOT NULL)");
  const find = db.prepare('SELECT value FROM draft WHERE slot = 1');
  const claim = db.prepare('INSERT OR IGNORE INTO draft (slot, value) VALUES (1, ?)');
  const save = db.prepare('UPDATE draft SET value = ? WHERE slot = 1 AND value = ?');
  let comparison;
  let creating = false;

  const request = (url, init) => transport(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  const current = () => JSON.parse(find.get()?.value ?? 'null');
  const update = (from, to) => {
    save.run(JSON.stringify(to), JSON.stringify(from));
    return current();
  };
  function state() {
    const attempt = current();
    if (attempt?.status === 'pending' && !creating) return { ...attempt, status: 'unconfirmed' };
    return attempt;
  }
  async function readBack(attempt, token) {
    if (attempt.status !== 'incomplete' || !attempt.id) return attempt;
    const verified = await verifyDraft(attempt, token, request).catch(() => false);
    return verified ? update(attempt, { ...attempt, status: 'verified' }) : current();
  }

  function requirePayPal() {
    if (!paypalKeys.every(key => env[key]?.trim())) {
      throw new HttpError(503, 'Configure the PayPal sandbox app and buyer email in .env.');
    }
  }

  async function route(req) {
    const path = req.url;
    if (req.method === 'GET' && path === '/api/draft') return state();
    if (req.method === 'POST' && path === '/api/compare') {
      if (current()) throw new HttpError(409, 'This demo already has a draft attempt.');
      if (!env.GEMINI_API_KEY?.trim() && !env.OPENAI_API_KEY?.trim()) {
        throw new HttpError(503, 'Set GEMINI_API_KEY or OPENAI_API_KEY in .env.');
      }
      const { agreement, notes } = await readJson(req);
      if ([agreement, notes].some(value => typeof value !== 'string' || !value.trim() || value.length > 8000)) {
        throw new HttpError(400, 'Enter both records, up to 8,000 characters each.');
      }
      const charges = await compareRecords(agreement, notes, env, request).catch(() => {
        throw new HttpError(502, 'AI comparison could not be completed. Check the model settings and try again.');
      });
      comparison = { id: randomUUID(), charges };
      return comparison;
    }
    if (req.method === 'POST' && path === '/api/draft/verify') {
      const attempt = state();
      if (!attempt || attempt.status !== 'incomplete') return attempt;
      requirePayPal();
      const token = await sandboxToken(env, request).catch(() => null);
      return token ? readBack(attempt, token) : attempt;
    }
    if (req.method === 'POST' && path === '/api/draft') {
      if (current()) return state();
      requirePayPal();
      const { comparisonId, selectedIds } = await readJson(req);
      if (!comparison || comparison.id !== comparisonId || !Array.isArray(selectedIds)
          || !selectedIds.length || new Set(selectedIds).size !== selectedIds.length) {
        throw new HttpError(409, 'Compare the current records and confirm the selected charges.');
      }
      const review = comparison;
      const items = review.charges.filter(item => selectedIds.includes(item.id) && item.amount !== null)
        .map(({ name, amount }) => ({ name, amount }));
      if (items.length !== selectedIds.length) throw new HttpError(400, 'Only supported charges can be included.');

      const token = await sandboxToken(env, request).catch(() => {
        throw new HttpError(502, 'PayPal sandbox authorization failed before any draft was requested.');
      });
      if (current()) return state();
      if (comparison !== review) throw new HttpError(409, 'The comparison changed. Review the current charges again.');
      const attempt = {
        status: 'pending',
        reference: 'STI-' + randomUUID().replaceAll('-', '').slice(0, 16),
        items,
        total: items.reduce((sum, item) => sum + item.amount, 0),
      };
      if (!claim.run(JSON.stringify(attempt)).changes) return state();
      creating = true;
      try {
        const result = await createDraft(attempt, token, env, request).catch(() => ({ status: 'unconfirmed' }));
        return await readBack(update(attempt, { ...attempt, ...result }), token);
      } finally {
        creating = false;
      }
    }
    throw new HttpError(404, 'Route not found.');
  }

  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const local = '127.0.0.1:' + server.address().port;
      const alias = 'localhost:' + server.address().port;
      if (![local, alias].includes(req.headers.host)
          || (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host)) {
        throw new HttpError(403, 'Use the local app URL.');
      }
      const asset = req.method === 'GET' && assets.get(req.url);
      if (asset) {
        res.setHeader('Content-Type', asset[1]);
        res.end(readFileSync(new URL('./public/' + asset[0], import.meta.url)));
        return;
      }
      const value = await route(req);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(value));
    } catch (error) {
      res.writeHead(error.status || 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.status ? error.message : 'The app could not complete this request.' }));
    }
  });
  server.on('close', () => db.close());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 4173);
  const server = makeServer();
  server.listen(port, '127.0.0.1', () => console.log('Scope-to-Invoice at http://127.0.0.1:' + server.address().port));
}
