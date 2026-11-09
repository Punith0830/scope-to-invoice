import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { makeServer } from './server.mjs';

const agreement = 'Brand direction workshop and summary: USD 600 fixed fee.';
const notes = 'Completed the brand direction workshop and delivered the summary. Also completed social graphics.';
const id = 'INV2-TEST-TEST-TEST-TEST';
const paypalEnv = {
  PAYPAL_SANDBOX_CLIENT_ID: 'test',
  PAYPAL_SANDBOX_CLIENT_SECRET: 'test',
  PAYPAL_SANDBOX_BUYER_EMAIL: 'sandbox@example.test',
};
const env = { ...paypalEnv, OPENAI_API_KEY: 'test' };
const findings = [
  {
    name: 'Brand direction workshop and summary',
    decision: 'supported',
    agreementLine: agreement,
    workQuote: 'Completed the brand direction workshop and delivered the summary.',
    reason: '',
  },
  {
    name: 'Social graphics',
    decision: 'unresolved',
    agreementLine: '',
    workQuote: 'Also completed social graphics.',
    reason: 'The agreement gives no price.',
  },
];

async function start(t, { result = findings, timeout = false, mismatch = false, config = env } = {}) {
  let payload;
  let creates = 0;
  let reads = 0;
  const transport = async (url, init) => {
    if (url === 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent') {
      const input = JSON.parse(init.body);
      assert.equal(init.headers['x-goog-api-key'], config.GEMINI_API_KEY);
      assert.equal(input.generationConfig.responseMimeType, 'application/json');
      assert.deepEqual(input.generationConfig.responseJsonSchema.required, ['charges']);
      assert.deepEqual(JSON.parse(input.contents[0].parts[0].text), { agreement, workNotes: notes });
      return Response.json({ candidates: [{ finishReason: 'STOP', content: {
        parts: [{ text: JSON.stringify({ charges: result }) }],
      } }] });
    }
    if (url === 'https://api.openai.com/v1/responses') {
      assert.equal(config.OPENAI_API_KEY, 'test');
      const input = JSON.parse(init.body);
      assert.equal(input.store, false);
      assert.equal(input.text.format.type, 'json_schema');
      return Response.json({ status: 'completed', output: [{
        type: 'message',
        content: [{ type: 'output_text', text: JSON.stringify({ charges: result }) }],
      }] });
    }
    assert(url.startsWith('https://api-m.sandbox.paypal.com/'));
    if (url.endsWith('/v1/oauth2/token')) return Response.json({ access_token: 'mock' });
    if (init.method === 'POST') {
      creates++;
      payload = JSON.parse(init.body);
      if (timeout) throw new Error('Simulated lost response');
      return Response.json({ href: url + '/' + id }, { status: 201 });
    }
    reads++;
    assert.equal(url.split('/').at(-1), id);
    return Response.json({
      id,
      status: 'DRAFT',
      detail: { invoice_number: payload.detail.invoice_number },
      items: payload.items,
      amount: { currency_code: 'USD', value: mismatch && reads === 1 ? '601.00' : '600.00' },
    });
  };
  const server = makeServer({ env: config, database: ':memory:', transport });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  return {
    get creates() { return creates; },
    get reads() { return reads; },
    get payload() { return payload; },
    request(path, body) {
      return fetch(base + path, body === undefined ? undefined : {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    },
  };
}

test('Gemini works without an OpenAI key and only supported charges reach the verified draft', async t => {
  const app = await start(t, { config: { ...paypalEnv, GEMINI_API_KEY: 'gemini-test' } });
  assert.match(await (await app.request('/')).text(), /Scope-to-Invoice/);
  assert.equal(await (await app.request('/api/draft')).json(), null);
  const { id: comparisonId, charges } = await (await app.request('/api/compare', { agreement, notes })).json();
  assert.deepEqual(charges.map(item => item.amount), [60000, null]);
  const bad = await app.request('/api/draft', { comparisonId, selectedIds: [2] });
  assert.equal(bad.status, 400);
  assert.equal(app.creates, 0);
  const order = { comparisonId, selectedIds: [1] };
  const responses = await Promise.all([app.request('/api/draft', order), app.request('/api/draft', order)]);
  assert.equal(app.creates, 1);
  assert(responses.every(response => response.ok));
  const verified = await (await app.request('/api/draft')).json();
  assert.equal(verified.status, 'verified');
  assert.equal(verified.id, id);
  assert.equal(app.payload.items.length, 1);
  assert.equal(app.payload.items[0].unit_amount.value, '600.00');
});

test('an uncertain create stays held across later requests', async t => {
  const app = await start(t, { timeout: true });
  const { id: comparisonId } = await (await app.request('/api/compare', { agreement, notes })).json();
  const order = { comparisonId, selectedIds: [1] };
  assert.equal((await (await app.request('/api/draft', order)).json()).status, 'unconfirmed');
  assert.equal((await (await app.request('/api/draft', order)).json()).status, 'unconfirmed');
  assert.equal(app.creates, 1);
  assert.equal(app.reads, 0);
});

test('a mismatched readback can recheck only the known invoice', async t => {
  const app = await start(t, { mismatch: true });
  const { id: comparisonId } = await (await app.request('/api/compare', { agreement, notes })).json();
  const order = { comparisonId, selectedIds: [1] };
  const created = await (await app.request('/api/draft', order)).json();
  assert.equal(created.status, 'incomplete');
  assert.equal(created.id, id);
  assert.equal((await (await app.request('/api/draft/verify', {})).json()).status, 'verified');
  assert.equal(app.creates, 1);
  assert.equal(app.reads, 2);
});

test('invented excerpts and multiple charges citing one fixed fee stay unresolved', async t => {
  const app = await start(t, { result: [
    findings[0],
    { ...findings[0], name: 'Duplicate fee' },
    { ...findings[0], name: 'Invented price', agreementLine: 'Agreed to USD 900.' },
  ] });
  const { charges } = await (await app.request('/api/compare', { agreement, notes })).json();
  assert.deepEqual(charges.map(item => item.amount), [null, null, null]);
});

test('missing credentials are reported before provider calls', async t => {
  const app = await start(t, { config: {} });
  assert.equal((await app.request('/api/compare', { agreement, notes })).status, 503);
  assert.equal((await app.request('/api/draft', {})).status, 503);
  assert.equal(app.creates, 0);
});
