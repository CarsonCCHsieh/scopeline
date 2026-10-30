import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep, basename } from 'node:path';
import { once } from 'node:events';
import { createScopeServer } from '../src/server.mjs';
import { OrderLedger } from '../src/order-ledger.mjs';

const ORDER = 'TESTORDER12345678', CAPTURE = 'TESTCAPTURE123456', MERCHANT = 'TESTMERCHANT12345';
const scope = { sku: 'thumbnail_pack', deliverables: 3, secondsPerDeliverable: null, captionsLanguage: null,
  aspectRatio: '16:9', revisions: 1, deliveryDays: 3, deliveryStarts: 'source_receipt', sourceReady: true,
  musicRights: 'none', publishRequested: false };

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'scopeline-payment-http-'));
  const ledger = OrderLedger.open(directory);
  const f = { directory, ledger, requests: [], orderStatus: 'CREATED', captureStatus: 'COMPLETED', hook: null };
  const transport = async request => {
    assert.equal(new URL(request.url).origin, 'https://api-m.sandbox.paypal.com');
    f.requests.push(structuredClone({ method: request.method, url: request.url, headers: request.headers, body: request.body }));
    if (f.hook) { const result = await f.hook(request); if (result !== undefined) return result; }
    const path = new URL(request.url).pathname;
    if (request.method === 'POST' && path === '/v2/checkout/orders') {
      f.unit = structuredClone(request.body.purchase_units[0]);
      f.checkout = request.body.payment_source.paypal.experience_context;
      return { status: 201, body: { id: ORDER } };
    }
    if (request.method === 'GET' && path === `/v2/checkout/orders/${ORDER}`) return { status: 200, body: {
      id: ORDER, intent: 'CAPTURE', status: f.orderStatus, purchase_units: [{ ...f.unit,
        ...(f.orderStatus === 'COMPLETED' ? { payments: { captures: [{ id: CAPTURE }] } } : {}) }],
    } };
    if (request.method === 'POST' && path === `/v2/checkout/orders/${ORDER}/capture`) {
      f.orderStatus = 'COMPLETED'; return { status: 201, body: { id: ORDER } };
    }
    if (request.method === 'GET' && path === `/v2/payments/captures/${CAPTURE}`) return { status: 200, body: {
      id: CAPTURE, status: f.captureStatus, final_capture: true, amount: f.unit.amount,
      payee: { merchant_id: MERCHANT }, supplementary_data: { related_ids: { order_id: ORDER } },
    } };
    assert.fail('Unexpected synthetic payment request.');
  };
  f.server = createScopeServer({ extractor: { extractDraft: async () => { throw Error('Not used'); } },
    payments: { ledger, merchantId: MERCHANT, transport }, ...options });
  f.server.listen(0, '127.0.0.1'); await once(f.server, 'listening');
  f.base = `http://127.0.0.1:${f.server.address().port}`;
  f.bootstrap = async () => {
    const response = await fetch(f.base + '/api/session');
    return { cookie: response.headers.get('set-cookie').split(';')[0], ...(await response.json()) };
  };
  f.current = async session => (await fetch(f.base + '/api/session', { headers: { Cookie: session.cookie } })).json();
  f.post = async (session, path, body = {}, headers = {}) => {
    const response = await fetch(f.base + path, { method: 'POST', headers: { Cookie: session.cookie,
      Origin: f.base, 'X-CSRF-Token': session.csrf, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: response.status, ...(await response.json()) };
  };
  f.quote = async session => {
    const draft = (await f.post(session, '/api/drafts', { rawBrief: 'Cleared synthetic thumbnail request.', mode: 'manual' })).draft;
    const reviewed = (await f.post(session, `/api/drafts/${draft.id}/review`, {
      expectedVersion: draft.version, scope, decisions: [], resolutions: [], confirmSourceGrounding: true, confirmRights: true,
    })).draft;
    return (await f.post(session, `/api/drafts/${draft.id}/quote`, { expectedVersion: reviewed.version,
      reviewDigest: reviewed.review.digest, confirmScope: true, acceptCatalogPrice: true, expectedTotalCents: 4500 })).quote;
  };
  f.posts = ending => f.requests.filter(request => request.method === 'POST' && request.url.endsWith(ending));
  t.after(async () => {
    await new Promise(done => { f.server.close(done); f.server.closeAllConnections(); }); ledger.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    assert.ok(basename(directory).startsWith('scopeline-payment-http-'));
    await rm(directory, { recursive: true });
  });
  return f;
}

test('HTTP sandbox remains disabled unless trusted payment dependencies are explicitly injected', async t => {
  const f = await fixture(t, { payments: null }); const s = await f.bootstrap(); const q = await f.quote(s);
  assert.equal(s.capabilities.paypal, false); assert.equal(s.payment, null);
  const denied = await f.post(s, '/api/payments/create', { quoteId: q.id });
  assert.equal(denied.status, 503); assert.equal(denied.error.code, 'paypal_disabled'); assert.equal(f.requests.length, 0);
});

test('HTTP uses fixed server quote money and durable idempotent intent, never browser prices or links', async t => {
  const f = await fixture(t); const s = await f.bootstrap(); const q = await f.quote(s);
  assert.equal(s.capabilities.paypal, true);
  for (const bad of [{ quoteId: q.id, amount: '0.01' }, { quoteId: q.id, currency: 'TWD' }, { quoteId: q.id, owner: 'foreign' },
    { quoteId: q.id, returnUrl: 'https://attacker.invalid' }]) assert.equal((await f.post(s, '/api/payments/create', bad)).status, 422);
  assert.equal(f.requests.length, 0);
  const created = await f.post(s, '/api/payments/create', { quoteId: q.id });
  assert.equal(created.status, 200); assert.equal(created.payment.state, 'created');
  assert.deepEqual(created.payment.amount, { currency: 'USD', value: '45.00' });
  assert.equal(created.payment.approvalUrl, `https://www.sandbox.paypal.com/checkoutnow?token=${ORDER}`);
  assert.equal(f.unit.payee.merchant_id, MERCHANT); assert.deepEqual(f.unit.amount, { currency_code: 'USD', value: '45.00' });
  assert.equal(f.checkout.return_url, f.base + '/paypal/return'); assert.equal(f.checkout.cancel_url, f.base + '/paypal/cancel');
  assert.equal(f.checkout.shipping_preference, 'NO_SHIPPING');
  const repeated = await f.post(s, '/api/payments/create', { quoteId: q.id });
  assert.equal(repeated.payment.id, created.payment.id); assert.equal(f.posts('/v2/checkout/orders').length, 1);
  assert.equal((await f.current(s)).payment.id, created.payment.id);
  assert.ok(!Object.hasOwn(created.payment, 'owner')); assert.ok(!Object.hasOwn(created.payment, 'createRequestId'));
});

test('HTTP payment actions enforce owner, Origin and CSRF before any provider call', async t => {
  const f = await fixture(t); const a = await f.bootstrap(), b = await f.bootstrap(); const q = await f.quote(a);
  assert.equal((await f.post(a, '/api/payments/create', { quoteId: q.id }, { 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await f.post(a, '/api/payments/create', { quoteId: q.id }, { Origin: 'https://attacker.invalid' })).status, 403);
  assert.equal(f.requests.length, 0);
  const created = (await f.post(a, '/api/payments/create', { quoteId: q.id })).payment;
  const before = f.requests.length;
  for (const action of ['capture', 'reconcile']) {
    assert.equal((await f.post(b, `/api/payments/${created.id}/${action}`)).status, 404);
    assert.equal((await f.post(a, `/api/payments/${created.id}/${action}`, { orderId: ORDER })).status, 422);
  }
  assert.equal(f.requests.length, before); assert.equal((await f.current(b)).payment, null);
});

test('HTTP callback never treats query strings as approval; capture requires matching independent provider evidence', async t => {
  const f = await fixture(t); const s = await f.bootstrap(), q = await f.quote(s);
  const created = (await f.post(s, '/api/payments/create', { quoteId: q.id })).payment;
  const callback = await fetch(f.base + '/paypal/return?token=FAKE&PayerID=DO_NOT_ECHO', { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(callback.status, 200); assert.doesNotMatch(await callback.text(), /DO_NOT_ECHO/);
  const premature = await f.post(s, `/api/payments/${created.id}/capture`);
  assert.equal(premature.payment.state, 'created'); assert.equal(f.posts('/capture').length, 0);
  f.orderStatus = 'APPROVED';
  const approved = await f.post(s, `/api/payments/${created.id}/reconcile`);
  assert.equal(approved.payment.providerOrderStatus, 'APPROVED'); assert.equal(approved.payment.approvalUrl, null);
  const captured = await f.post(s, `/api/payments/${created.id}/capture`);
  assert.equal(captured.payment.state, 'completed'); assert.equal(captured.payment.providerOrderStatus, 'COMPLETED');
  assert.equal(captured.payment.captureId, CAPTURE); assert.equal(f.posts('/capture').length, 1);
  assert.ok(f.requests.some(request => request.url.endsWith('/v2/payments/captures/' + CAPTURE)));
  assert.equal((await f.post(s, `/api/payments/${created.id}/capture`)).payment.state, 'completed');
  assert.equal(f.posts('/capture').length, 1);
});

test('HTTP pins review, quote and replacement drafts, blocks unresolved Clear and retains completed history', async t => {
  const f = await fixture(t); const s = await f.bootstrap(), q = await f.quote(s);
  const created = (await f.post(s, '/api/payments/create', { quoteId: q.id })).payment;
  for (const [path, body] of [
    ['/api/drafts', { rawBrief: 'Another synthetic scope.', mode: 'manual' }],
    [`/api/drafts/${q.draftId}/review`, {}], [`/api/drafts/${q.draftId}/quote`, {}], ['/api/clear', {}],
  ]) { const result = await f.post(s, path, body); assert.equal(result.status, 409); assert.equal(result.error.code, 'payment_locked'); }
  f.orderStatus = 'APPROVED'; await f.post(s, `/api/payments/${created.id}/capture`);
  const cleared = await f.post(s, '/api/clear'); assert.equal(cleared.status, 200); assert.equal(cleared.payment, null);
  const journal = JSON.parse(await readFile(join(f.directory, 'orders.json'), 'utf8'));
  assert.equal(journal.entries.length, 1); assert.equal(journal.entries[0].state, 'completed');
  assert.equal((await f.post(s, `/api/payments/${created.id}/reconcile`)).status, 401);
});

test('HTTP uncertain create remains locked and never re-POSTs or invents an approval link', async t => {
  const f = await fixture(t); const s = await f.bootstrap(), q = await f.quote(s);
  f.hook = async request => { if (request.method === 'POST') throw Error('PRIVATE_PROVIDER_DIAGNOSTIC'); };
  const first = await f.post(s, '/api/payments/create', { quoteId: q.id });
  assert.equal(first.payment.state, 'unknown'); assert.equal(first.payment.orderId, null); assert.equal(first.payment.approvalUrl, null);
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE_PROVIDER_DIAGNOSTIC/);
  await f.post(s, '/api/payments/create', { quoteId: q.id }); await f.post(s, `/api/payments/${first.payment.id}/reconcile`);
  assert.equal(f.posts('/v2/checkout/orders').length, 1); assert.equal((await f.post(s, '/api/clear')).status, 409);
});

test('HTTP lost capture response permits fixed GET recovery but never another capture POST', async t => {
  const f = await fixture(t); const s = await f.bootstrap(), q = await f.quote(s);
  const created = (await f.post(s, '/api/payments/create', { quoteId: q.id })).payment; f.orderStatus = 'APPROVED';
  f.hook = async request => { if (request.method === 'POST' && request.url.endsWith('/capture')) { f.orderStatus = 'COMPLETED'; throw Error('lost response'); } };
  const unknown = await f.post(s, `/api/payments/${created.id}/capture`); assert.equal(unknown.payment.state, 'unknown');
  const recovered = await f.post(s, `/api/payments/${created.id}/capture`);
  assert.equal(recovered.payment.state, 'completed'); assert.equal(f.posts('/capture').length, 1);
});

test('HTTP in-flight payment locks Clear and draft mutation before asynchronous transport returns', async t => {
  const f = await fixture(t); const s = await f.bootstrap(), q = await f.quote(s);
  let unblock; const held = new Promise(resolve => { unblock = resolve; }); let started;
  const seen = new Promise(resolve => { started = resolve; });
  f.hook = async request => { if (request.method === 'POST' && request.url.endsWith('/v2/checkout/orders')) { started(); await held; } };
  const pending = f.post(s, '/api/payments/create', { quoteId: q.id }); await seen;
  assert.equal((await f.post(s, '/api/clear')).status, 409);
  assert.equal((await f.post(s, `/api/drafts/${q.draftId}/review`, {})).error.code, 'payment_busy');
  assert.equal((await f.post(s, '/api/payments/create', { quoteId: q.id })).error.code, 'payment_busy');
  unblock(); assert.equal((await pending).payment.state, 'created'); assert.equal(f.posts('/v2/checkout/orders').length, 1);
});

test('HTTP expiry during provider work revokes browser access while retaining the durable operation', async t => {
  let now = 1000; const f = await fixture(t, { clock: () => now, sessionIdleMs: 100 });
  const s = await f.bootstrap(), q = await f.quote(s);
  f.hook = async request => { if (request.method === 'POST') { now += 101; throw Error('uncertain'); } };
  const result = await f.post(s, '/api/payments/create', { quoteId: q.id });
  assert.equal(result.status, 409); assert.equal(result.error.code, 'session_changed');
  const fresh = await f.bootstrap(); assert.equal(fresh.payment, null); assert.equal(fresh.quote, null);
  const journal = JSON.parse(await readFile(join(f.directory, 'orders.json'), 'utf8'));
  assert.equal(journal.entries.length, 1); assert.equal(journal.entries[0].state, 'unknown');
  assert.equal((await f.post(fresh, `/api/payments/${journal.entries[0].id}/reconcile`)).status, 404);
});
