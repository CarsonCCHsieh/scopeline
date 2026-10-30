import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { ScopeBook } from '../src/domain.mjs';
import { OrderLedger } from '../src/order-ledger.mjs';
import { PaymentService, PAYPAL_SANDBOX_ORIGIN } from '../src/payment-service.mjs';

// Every provider response below is synthetic. No fetch, model, OAuth, account,
// actual PayPal API or payment is invoked. Files live in owned OS-temp fixtures.
const OWNER = 'synthetic-owner-a';
const MERCHANT = 'TESTMERCHANT123';
const ORDER = 'ORDER00000000001';
const CAPTURE = 'CAPTURE000000001';
const copy = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const rejects = (promise, code) => assert.rejects(promise, error => error?.code === code);
const throws = (fn, code) => assert.throws(fn, error => error?.code === code);
const scope = { sku: 'thumbnail_pack', deliverables: 3, secondsPerDeliverable: null, captionsLanguage: null,
  aspectRatio: '16:9', revisions: 1, deliveryDays: 3, deliveryStarts: 'source_receipt', sourceReady: true,
  musicRights: 'none', publishRequested: false };
function makeQuote(book = new ScopeBook(), owner = OWNER) {
  const draft = book.createDraft(owner, 'Synthetic brief: three thumbnail concepts.', { requestedRequirements: [], missingQuestions: [] });
  return { book, ...review(book, owner, draft) };
}
function review(book, owner, draft, changes = {}) {
  const reviewed = book.reviewDraft(owner, draft.id, { expectedVersion: draft.version, scope: { ...scope, ...changes },
    decisions: [], resolutions: [], confirmSourceGrounding: true, confirmRights: true });
  const quote = book.confirmQuote(owner, reviewed.id, { expectedVersion: reviewed.version, reviewDigest: reviewed.review.digest,
    confirmScope: true, acceptCatalogPrice: true, expectedTotalCents: 4500 });
  return { draft: book.getDraft(owner, reviewed.id), quote };
}
function fixture(t, { io = fs, timeoutMs = 20000 } = {}) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'scopeline-order-test-'));
  const { book, draft, quote } = makeQuote();
  const f = { directory, book, draft, quote, requests: [], orderStatus: 'CREATED', captureStatus: 'COMPLETED',
    mutateOrder: body => body, mutateCapture: body => body, hook: null };
  f.ledger = OrderLedger.open(directory, { io });
  f.orderBody = () => f.mutateOrder({ id: ORDER, intent: 'CAPTURE', status: f.orderStatus,
    purchase_units: [{ ...copy(f.unit), ...(f.orderStatus === 'COMPLETED'
      ? { payments: { captures: [{ id: CAPTURE, status: f.captureStatus }] } } : {}) }] });
  f.captureBody = () => f.mutateCapture({ id: CAPTURE, status: f.captureStatus, final_capture: true,
    amount: copy(f.unit.amount), payee: { merchant_id: MERCHANT },
    supplementary_data: { related_ids: { order_id: ORDER } } });
  f.transport = async request => {
    assert.equal(new URL(request.url).origin, PAYPAL_SANDBOX_ORIGIN);
    const path = new URL(request.url).pathname;
    const call = { method: request.method, path, headers: copy(request.headers),
      ...(request.body === undefined ? {} : { body: copy(request.body) }) };
    f.requests.push(call);
    if (f.hook) {
      const result = await f.hook(request, call);
      if (result !== undefined) return result;
    }
    if (request.method === 'POST' && path === '/v2/checkout/orders') {
      f.unit = copy(request.body.purchase_units[0]);
      return { status: 201, body: { id: ORDER, status: 'CREATED', links: [{ href: 'https://api-m.paypal.com/never-follow' }] } };
    }
    if (request.method === 'GET' && path === `/v2/checkout/orders/${ORDER}`) return { status: 200, body: f.orderBody() };
    if (request.method === 'POST' && path === `/v2/checkout/orders/${ORDER}/capture`) {
      f.orderStatus = 'COMPLETED';
      return { status: 201, body: { id: ORDER } }; // Official POST can omit full amount/payee.
    }
    if (request.method === 'GET' && path === `/v2/payments/captures/${CAPTURE}`) return { status: 200, body: f.captureBody() };
    assert.fail(`Unexpected synthetic transport request: ${request.method} ${path}`);
  };
  f.service = new PaymentService({ ledger: f.ledger, book, merchantId: MERCHANT, transport: f.transport, timeoutMs });
  f.reopen = ({ book: nextBook = book } = {}) => {
    f.ledger.close(); f.ledger = OrderLedger.open(directory);
    f.service = new PaymentService({ ledger: f.ledger, book: nextBook, merchantId: MERCHANT, transport: f.transport, timeoutMs });
  };
  f.posts = suffix => f.requests.filter(r => r.method === 'POST' && r.path.endsWith(suffix));
  t.after(() => {
    f.ledger.close();
    const target = resolve(directory), temporaryRoot = resolve(tmpdir()) + sep;
    assert.ok(target.startsWith(temporaryRoot) && basename(target).startsWith('scopeline-order-test-'));
    fs.rmSync(target, { recursive: true, force: true });
  });
  return f;
}

test('durable reservation pins catalog quote/owner and distinct stable UUIDs without retaining the brief', t => {
  const f = fixture(t);
  const { record } = f.ledger.reserve(OWNER, f.quote, MERCHANT);
  assert.equal(record.state, 'creating'); assert.equal(record.environment, 'sandbox');
  assert.equal(record.quote.totalCents, 4500); assert.equal(record.quote.currency, 'USD');
  assert.equal(record.quote.reviewDigest, f.quote.reviewDigest); assert.equal(record.quote.scopeVersion, f.quote.scopeVersion);
  assert.notEqual(record.createRequestId, record.captureRequestId); assert.equal(record.createRequestId.length, 36);
  throws(() => { record.quote.totalCents = 1; }, undefined);
  const bytes = fs.readFileSync(join(f.directory, 'orders.json'), 'utf8');
  assert.ok(!bytes.includes(f.quote.scopeAudit.rawBrief)); assert.ok(!bytes.includes('scopeAudit'));
  throws(() => OrderLedger.open(f.directory), 'ledger_locked');
  throws(() => f.ledger.get('foreign-owner', record.id), 'not_found');
  assert.equal(f.ledger.findForQuote('foreign-owner', f.quote.id), null);
  f.reopen();
  const recovered = f.ledger.get(OWNER, record.id);
  assert.equal(recovered.state, 'unknown'); assert.equal(recovered.lastIssue, 'recovered_inflight');
  assert.equal(recovered.createRequestId, record.createRequestId);
  assert.equal(typeof f.ledger.clear, 'undefined'); assert.equal(typeof f.ledger.delete, 'undefined');
});

test('double create shares one request; persisted duplicates and restart never create another order', async t => {
  const f = fixture(t), entered = deferred(), release = deferred();
  f.hook = async (_request, call) => { if (call.method === 'POST') { entered.resolve(); await release.promise; } };
  const first = f.service.createOrder(OWNER, f.quote.id), second = f.service.createOrder(OWNER, f.quote.id);
  assert.equal(first, second); await entered.promise;
  const disk = JSON.parse(fs.readFileSync(join(f.directory, 'orders.json'), 'utf8')).entries[0];
  assert.equal(disk.state, 'creating'); assert.equal(disk.orderId, null);
  release.resolve(); const created = await first;
  assert.equal(created.state, 'created'); assert.equal(f.posts('/orders').length, 1);
  const request = f.posts('/orders')[0];
  assert.equal(request.headers['PayPal-Request-Id'], created.createRequestId);
  assert.equal(request.headers.Prefer, 'return=representation');
  assert.equal(request.body.purchase_units[0].amount.value, '45.00');
  await f.service.createOrder(OWNER, f.quote.id); f.reopen(); await f.service.createOrder(OWNER, f.quote.id);
  assert.equal(f.posts('/orders').length, 1);
});

test('capture intent is durable before POST; minimal POST success needs matching order AND capture GET evidence', async t => {
  const f = fixture(t); const created = await f.service.createOrder(OWNER, f.quote.id); f.orderStatus = 'APPROVED';
  const entered = deferred(), release = deferred();
  f.hook = async (_request, call) => { if (call.path.endsWith('/capture')) { entered.resolve(); await release.promise; } };
  const first = f.service.captureOrder(OWNER, created.id), second = f.service.captureOrder(OWNER, created.id);
  assert.equal(first, second); await entered.promise;
  const intent = JSON.parse(fs.readFileSync(join(f.directory, 'orders.json'), 'utf8')).entries[0];
  assert.equal(intent.state, 'capture_pending'); assert.equal(intent.captureStarted, true);
  release.resolve(); const result = await first;
  assert.equal(result.state, 'completed'); assert.equal(result.captureId, CAPTURE);
  assert.deepEqual(result.completionEvidence.orderStatus, 'COMPLETED');
  assert.equal(f.posts('/capture').length, 1);
  assert.equal(f.posts('/capture')[0].headers['PayPal-Request-Id'], created.captureRequestId);
  assert.ok(f.requests.some(r => r.path === `/v2/payments/captures/${CAPTURE}`));
  f.reopen({ book: new ScopeBook() }); await f.service.captureOrder(OWNER, created.id);
  assert.equal(f.posts('/capture').length, 1);
  await rejects(f.service.captureOrder('foreign-owner', created.id), 'not_found');
});

test('stale quote cannot create/capture, and a later quote cannot replace an ordered draft', async t => {
  const f = fixture(t);
  const next = review(f.book, OWNER, f.draft, { deliverables: 2 });
  await rejects(f.service.createOrder(OWNER, f.quote.id), 'stale_quote'); assert.equal(f.requests.length, 0);
  const created = await f.service.createOrder(OWNER, next.quote.id);
  const newer = review(f.book, OWNER, next.draft, { deliverables: 1 });
  f.orderStatus = 'APPROVED';
  await rejects(f.service.captureOrder(OWNER, created.id), 'stale_quote');
  await rejects(f.service.createOrder(OWNER, newer.quote.id), 'draft_locked');
  assert.equal(f.posts('/capture').length, 0); assert.equal(f.posts('/orders').length, 1);
});

test('scope edits racing with approval GET are checked again before capture is persisted or sent', async t => {
  const f = fixture(t); const created = await f.service.createOrder(OWNER, f.quote.id); f.orderStatus = 'APPROVED';
  const entered = deferred(), release = deferred();
  f.hook = async (_request, call) => { if (call.method === 'GET') { entered.resolve(); await release.promise; } };
  const pending = f.service.captureOrder(OWNER, created.id); await entered.promise;
  review(f.book, OWNER, f.draft, { deliverables: 2 }); release.resolve();
  await rejects(pending, 'stale_quote'); assert.equal(f.posts('/capture').length, 0);
  assert.equal(f.ledger.get(OWNER, created.id).captureStarted, false);
});

test('lost create response has no GET-by-request-id fallback and survives Clear-like book replacement without a new POST', async t => {
  const f = fixture(t);
  f.hook = async (_request, call) => { if (call.method === 'POST') throw new Error('synthetic lost response'); };
  const unknown = await f.service.createOrder(OWNER, f.quote.id);
  assert.equal(unknown.state, 'unknown'); assert.equal(unknown.orderId, null);
  await f.service.createOrder(OWNER, f.quote.id); await f.service.reconcile(OWNER, unknown.id);
  f.reopen({ book: new ScopeBook() });
  const same = await f.service.createOrder(OWNER, f.quote.id);
  assert.equal(same.id, unknown.id); assert.equal(same.createRequestId, unknown.createRequestId);
  assert.equal(f.requests.length, 1); assert.equal(f.ledger.get(OWNER, same.id).state, 'unknown');
});

test('lost capture response is reconciled after restart by GET only, even when session book was cleared', async t => {
  const f = fixture(t); const created = await f.service.createOrder(OWNER, f.quote.id); f.orderStatus = 'APPROVED';
  f.hook = async (_request, call) => { if (call.path.endsWith('/capture')) { f.orderStatus = 'COMPLETED'; throw new Error('lost after acceptance'); } };
  const unknown = await f.service.captureOrder(OWNER, created.id);
  assert.equal(unknown.state, 'unknown'); assert.equal(unknown.captureStarted, true);
  f.hook = null; f.reopen({ book: new ScopeBook() });
  const result = await f.service.captureOrder(OWNER, unknown.id);
  assert.equal(result.state, 'completed'); assert.equal(result.captureId, CAPTURE);
  assert.equal(result.captureRequestId, unknown.captureRequestId); assert.equal(f.posts('/capture').length, 1);
});

test('APPROVED after an uncertain capture never clears the no-rePOST fence', async t => {
  const f = fixture(t); const created = await f.service.createOrder(OWNER, f.quote.id); f.orderStatus = 'APPROVED';
  f.hook = async (_request, call) => { if (call.path.endsWith('/capture')) throw new Error('unknown acceptance'); };
  assert.equal((await f.service.captureOrder(OWNER, created.id)).state, 'unknown');
  f.hook = null;
  for (let i = 0; i < 2; i++) assert.equal((await f.service.captureOrder(OWNER, created.id)).state, 'unknown');
  assert.equal(f.posts('/capture').length, 1); assert.equal(f.ledger.get(OWNER, created.id).captureStarted, true);
});

test('provider order mismatches cannot become capturable records', async t => {
  const mutations = {
    amount: b => { b.purchase_units[0].amount.value = '44.99'; },
    currency: b => { b.purchase_units[0].amount.currency_code = 'EUR'; },
    merchant: b => { b.purchase_units[0].payee.merchant_id = 'OTHERSELLER123'; },
    reference: b => { b.purchase_units[0].reference_id = 'foreign-reference'; },
    quote: b => { b.purchase_units[0].custom_id = 'foreign-quote'; },
    invoice: b => { b.purchase_units[0].invoice_id = 'foreign-invoice'; },
    order: b => { b.id = 'OTHERORDER00001'; },
    intent: b => { b.intent = 'AUTHORIZE'; },
    partial: b => { delete b.purchase_units[0].amount; },
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, async sub => {
    const f = fixture(sub); f.mutateOrder = b => { mutate(b); return b; };
    const result = await f.service.createOrder(OWNER, f.quote.id);
    assert.equal(result.state, 'unknown'); assert.equal(result.completionEvidence, null);
    await f.service.captureOrder(OWNER, result.id); assert.equal(f.posts('/capture').length, 0);
  });
});

test('COMPLETED order alone never substitutes for verified full capture details', async t => {
  const mutations = {
    pending: b => { b.status = 'PENDING'; },
    declined: b => { b.status = 'DECLINED'; },
    amount: b => { b.amount.value = '0.45'; },
    exponent: b => { b.amount.value = '4.5e1'; },
    currency: b => { b.amount.currency_code = 'EUR'; },
    merchant: b => { b.payee.merchant_id = 'OTHERSELLER123'; },
    relationship: b => { b.supplementary_data.related_ids.order_id = 'OTHERORDER00001'; },
    capture: b => { b.id = 'OTHERCAPTURE001'; },
    partial: b => { b.final_capture = false; },
    absent: b => { delete b.payee; },
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, async sub => {
    const f = fixture(sub); const created = await f.service.createOrder(OWNER, f.quote.id); f.orderStatus = 'APPROVED';
    f.mutateCapture = b => { mutate(b); return b; };
    const result = await f.service.captureOrder(OWNER, created.id);
    assert.equal(result.state, 'unknown'); assert.equal(result.captureId, null); assert.equal(result.completionEvidence, null);
    assert.equal(f.posts('/capture').length, 1);
  });
});

test('unapproved provider state never dispatches capture and HTTP failures never claim completion', async t => {
  const f = fixture(t); const created = await f.service.createOrder(OWNER, f.quote.id);
  assert.equal((await f.service.captureOrder(OWNER, created.id)).state, 'created');
  assert.equal(f.posts('/capture').length, 0);
  f.hook = async (_request, call) => call.method === 'GET' ? { status: 404, body: { id: ORDER, status: 'COMPLETED' } } : undefined;
  assert.equal((await f.service.reconcile(OWNER, created.id)).state, 'unknown');
  assert.equal(f.ledger.get(OWNER, created.id).completionEvidence, null);
});

test('service merchant changes and foreign owners are rejected before any reconciliation traffic', async t => {
  const f = fixture(t); const created = await f.service.createOrder(OWNER, f.quote.id);
  const before = f.requests.length;
  const other = new PaymentService({ ledger: f.ledger, book: f.book, merchantId: 'OTHERSELLER123', transport: f.transport });
  await rejects(other.createOrder(OWNER, f.quote.id), 'merchant_changed');
  await rejects(other.captureOrder(OWNER, created.id), 'merchant_changed');
  await rejects(other.reconcile(OWNER, created.id), 'merchant_changed');
  await rejects(f.service.reconcile('foreign-owner', created.id), 'not_found');
  assert.equal(f.requests.length, before);
});

test('transport timeout aborts its signal and leaves one durable unknown intent without retry', async t => {
  const f = fixture(t, { timeoutMs: 5 }); let signal;
  f.hook = request => { signal = request.signal; return new Promise(() => {}); };
  const result = await f.service.createOrder(OWNER, f.quote.id);
  assert.equal(result.state, 'unknown'); assert.equal(signal.aborted, true);
  await f.service.createOrder(OWNER, f.quote.id); assert.equal(f.requests.length, 1);
});

test('failed reservation persistence dispatches no provider request and poisons that writer', async t => {
  let failing = false;
  const io = { ...fs, renameSync: (...args) => { if (failing) throw new Error('synthetic disk failure'); return fs.renameSync(...args); } };
  const f = fixture(t, { io }); failing = true;
  await rejects(f.service.createOrder(OWNER, f.quote.id), 'ledger_write_failed'); assert.equal(f.requests.length, 0);
  await rejects(f.service.createOrder(OWNER, f.quote.id), 'ledger_unavailable');
  f.reopen(); assert.equal(f.ledger.findForQuote(OWNER, f.quote.id), null);
});

test('write failure after provider acceptance cannot forget the pre-POST intent or silently retry', async t => {
  let failing = false;
  const io = { ...fs, renameSync: (...args) => { if (failing) throw new Error('synthetic disk failure'); return fs.renameSync(...args); } };
  const f = fixture(t, { io });
  f.hook = async (_request, call) => { if (call.method === 'POST') failing = true; };
  await rejects(f.service.createOrder(OWNER, f.quote.id), 'ledger_write_failed'); assert.equal(f.posts('/orders').length, 1);
  f.reopen(); const result = await f.service.createOrder(OWNER, f.quote.id);
  assert.equal(result.state, 'unknown'); assert.equal(result.orderId, null); assert.equal(f.posts('/orders').length, 1);
});

test('rename succeeded but fs reported uncertainty: reopen conservatively fences the persisted intent', async t => {
  let uncertain = false;
  const io = { ...fs, renameSync: (...args) => { fs.renameSync(...args); if (uncertain) throw new Error('synthetic post-rename error'); } };
  const f = fixture(t, { io }); uncertain = true;
  await rejects(f.service.createOrder(OWNER, f.quote.id), 'ledger_write_failed'); assert.equal(f.requests.length, 0);
  f.reopen(); const recovered = await f.service.createOrder(OWNER, f.quote.id);
  assert.equal(recovered.state, 'unknown'); assert.equal(f.requests.length, 0);
});

test('restart never replays a persisted capture intent, and abandoned writer locks require operator recovery', async t => {
  const f = fixture(t); const created = await f.service.createOrder(OWNER, f.quote.id);
  f.ledger.markCreated(OWNER, created.id, 'APPROVED'); const intent = f.ledger.startCapture(OWNER, created.id);
  f.reopen(); const recovered = f.ledger.get(OWNER, created.id);
  assert.equal(recovered.state, 'unknown'); assert.equal(recovered.captureRequestId, intent.captureRequestId);
  await f.service.captureOrder(OWNER, created.id); assert.equal(f.posts('/capture').length, 0);
  f.ledger.close(); fs.writeFileSync(join(f.directory, '.writer.lock'), '{"pid":99999999,"nonce":"synthetic"}');
  throws(() => OrderLedger.open(f.directory), 'ledger_locked');
  assert.ok(fs.existsSync(join(f.directory, '.writer.lock')));
});

test('corrupt journal is preserved and rejected rather than reset to an empty payment history', t => {
  const f = fixture(t); f.ledger.close();
  const file = join(f.directory, 'orders.json'); fs.writeFileSync(file, '{"format":1,"entries":[');
  throws(() => OrderLedger.open(f.directory), 'ledger_corrupt');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"format":1,"entries":[');
  assert.equal(fs.existsSync(join(f.directory, '.writer.lock')), false);
});
