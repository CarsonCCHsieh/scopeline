import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ScopeBook } from '../src/domain.mjs';
import { CATALOG, CATALOG_VERSION, SYSTEM_RESTRICTIONS } from '../src/catalog.mjs';
import { canCapturePayment, sandboxApprovalUrl, validPayment } from '../public/payment-state.mjs';
import { t as translatedText } from '../public/i18n.mjs';

// This harness loads the real app and its real event handlers. Its deliberately
// small DOM has no layout, native form validation, focus model or browser engine;
// passing these controlled-response checks is not browser or visual QA.
class Element {
  constructor(tag, document) {
    this.tagName = tag.toUpperCase(); this.document = document; this.children = [];
    this.parentNode = null; this.attributes = new Map(); this.dataset = {};
    this.listeners = new Map(); this.value = ''; this.checked = false;
    this.disabled = false; this.hidden = false; this.open = false; this._text = '';
  }
  setAttribute(name, value) {
    value = String(value); this.attributes.set(name, value);
    if (name === 'id') { this.id = value; this.document.ids.set(value, this); }
    else if (name === 'value') this.value = value;
    else if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
    else if (['disabled', 'hidden', 'checked'].includes(name)) this[name] = true;
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  append(...nodes) {
    for (const node of nodes) {
      const child = typeof node === 'string' ? { textContent: node } : node;
      child.parentNode = this; this.children.push(child);
    }
  }
  replaceChildren(...nodes) {
    const detach = node => {
      if (node.id && this.document.ids.get(node.id) === node) this.document.ids.delete(node.id);
      for (const child of node.children ?? []) detach(child);
      node.parentNode = null;
    };
    for (const node of this.children) detach(node);
    this.children = []; this._text = ''; this.append(...nodes);
  }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  get textContent() { return this._text + this.children.map(c => c.textContent ?? '').join(''); }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  fire(type, { bubbles = false } = {}) {
    const event = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    const pending = [];
    for (let node = this; node; node = bubbles ? node.parentNode : null) {
      for (const listener of node.listeners?.get(type) ?? []) pending.push(listener(event));
    }
    return Promise.all(pending);
  }
  click() {
    for (let node = this; node; node = node.parentNode) if (node.disabled) return Promise.resolve(false);
    return this.fire('click');
  }
  focus() { this.document.activeElement = this; }
  scrollIntoView() {}
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  showModal() { this.open = true; }
  close() { this.open = false; }
}

function makeDocument(html) {
  const document = {
    ids: new Map(), nodes: [],
    getElementById(id) { return this.ids.get(id) ?? null; },
    createElement(tag) { const node = new Element(tag, this); this.nodes.push(node); return node; },
    createTextNode(text) { return { textContent: String(text) }; },
    querySelectorAll(selector) {
      const attribute = /^\[([\w-]+)\]$/.exec(selector)?.[1];
      if (!attribute) throw new Error(`Harness does not implement selector ${selector}`);
      return this.nodes.filter(n => n.attributes.has(attribute));
    },
  };
  const stack = []; const voids = new Set(['meta', 'link', 'input', 'br', 'hr', 'img']);
  for (const match of html.matchAll(/<(\/?)([a-z][a-z\d-]*)([^>]*)>/gi)) {
    const [, closing, rawTag, attributes] = match; const tag = rawTag.toLowerCase();
    if (closing) {
      const index = stack.findLastIndex(n => n.tagName.toLowerCase() === tag);
      if (index >= 0) stack.length = index;
      continue;
    }
    const node = document.createElement(tag);
    for (const attr of attributes.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) node.setAttribute(attr[1], attr[2] ?? attr[3] ?? attr[4] ?? '');
    stack.at(-1)?.append(node);
    if (tag === 'html') document.documentElement = node;
    if (tag === 'body') document.body = node;
    if (!voids.has(tag)) stack.push(node);
  }
  return document;
}

const scope = { sku: 'clip_pack', deliverables: 3, secondsPerDeliverable: 30,
  captionsLanguage: 'English', aspectRatio: '9:16', revisions: 1,
  deliveryDays: 5, deliveryStarts: 'source_receipt', sourceReady: true,
  musicRights: 'none', publishRequested: false };

function records() {
  const book = new ScopeBook(); const owner = 'controlled-ui-test';
  const rawBrief = '3 synthetic clips for this local test.';
  const draft = book.createDraft(owner, rawBrief, { requestedRequirements: [
    { field: 'deliverables', value: 3, evidence: { start: 0, end: 1, quote: '3' } },
  ], missingQuestions: [] });
  const reviewed = book.reviewDraft(owner, draft.id, { expectedVersion: 1, scope,
    decisions: [{ field: 'deliverables', decision: 'accept', note: '' }], resolutions: [],
    confirmSourceGrounding: true, confirmRights: true });
  const quote = book.confirmQuote(owner, draft.id, { expectedVersion: reviewed.version,
    reviewDigest: reviewed.review.digest, confirmScope: true, acceptCatalogPrice: true,
    expectedTotalCents: 9000 });
  return { draft, reviewed, confirmed: book.getDraft(owner, draft.id), quote };
}

const bootstrap = (extra = {}) => ({ csrf: 'a'.repeat(64), catalogVersion: CATALOG_VERSION,
  catalog: CATALOG, systemRestrictions: SYSTEM_RESTRICTIONS,
  capabilities: { localAi: true, paypal: false, persistence: 'session-memory' },
  activity: { aiBusy: false, workspaceBusy: false }, extraction: null,
  draft: null, quote: null, ...extra });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const deferred = () => {
  let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));
let instance = 0;

async function harness(t, initial = bootstrap()) {
  const saved = new Map(['document', 'localStorage', 'fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const document = makeDocument(await readFile(new URL('../public/index.html', import.meta.url), 'utf8'));
  const queue = []; const calls = []; const unexpected = [];
  const enqueue = (path, result) => queue.push({ path, result });
  globalThis.document = document;
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  globalThis.fetch = async (path, options) => {
    calls.push({ path, options }); const next = queue.shift();
    if (!next || next.path !== path) { unexpected.push(path); throw new Error(`Unexpected controlled request ${path}`); }
    return typeof next.result === 'function' ? next.result() : await next.result;
  };
  t.after(() => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    assert.deepEqual(unexpected, [], 'all network operations are explicitly controlled');
    assert.equal(queue.length, 0, 'all planned requests were exercised');
  });
  enqueue('/api/session', json(initial));
  await import(`../public/app.mjs?controlled-ui-test=${++instance}`);
  const $ = id => document.getElementById(id);
  const enter = async (id, value) => { $(id).value = value; await $(id).fire('input', { bubbles: true }); };
  const check = async (id, value = true) => { $(id).checked = value; await $(id).fire('change', { bubbles: true }); };
  const startAi = async pending => {
    await enter('raw-brief', 'Synthetic pending brief.');
    enqueue('/api/drafts', pending.promise);
    await $('brief-form').fire('submit'); await tick();
  };
  const clear = async pending => {
    assert.equal($('clear-button').disabled, false, 'Clear entry remains available');
    await $('clear-button').click();
    assert.equal($('clear-dialog').open, true);
    assert.equal($('confirm-clear').disabled, false, 'Clear confirmation remains available');
    enqueue('/api/clear', pending.promise);
    const completion = $('confirm-clear').click(); await tick();
    return { completion };
  };
  return { $, document, calls, enqueue, enter, check, startAi, clear };
}

const sandboxPayment = (quote, extra = {}) => ({ id: 'test-operation-1', quoteId: quote.id,
  state: 'created', orderId: 'SANDBOXORDER123', captureId: null,
  providerOrderStatus: 'CREATED', lastIssue: null, sandboxOnly: true,
  amount: { currency: 'USD', value: '90.00' },
  approvalUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=SANDBOXORDER123',
  locked: true, ...extra });
const sandboxSession = (record, payment = null) => bootstrap({ draft: record.confirmed,
  quote: record.quote, payment, capabilities: { localAi: true, paypal: true, persistence: 'session-memory' } });

test('Sandbox capture requires consent, server approval reconciliation and a separate explicit click', async t => {
  const record = records(), created = sandboxPayment(record.quote);
  const f = await harness(t, sandboxSession(record));
  assert.equal(f.$('create-sandbox-payment').disabled, true);
  assert.equal(f.$('capture-sandbox-payment'), null);
  await f.check('sandbox-consent');
  assert.equal(f.$('create-sandbox-payment').disabled, false);
  f.enqueue('/api/payments/create', json({ payment: created }));
  await f.$('create-sandbox-payment').click();
  assert.deepEqual(JSON.parse(f.calls.at(-1).options.body), { quoteId: record.quote.id });
  assert.equal(f.calls.at(-1).options.headers['X-CSRF-Token'], 'a'.repeat(64));
  assert.equal(f.$('clear-button').disabled, true);
  assert.equal(f.$('review-controls').disabled, true);
  assert.equal(f.$('quote-controls').disabled, true);
  assert.equal(f.$('sandbox-approval-link').getAttribute('target'), '_blank');
  assert.equal(f.$('sandbox-approval-link').getAttribute('rel'), 'noopener noreferrer');
  assert.equal(f.$('capture-sandbox-payment'), null);
  assert.equal(f.calls.length, 2, 'creating an order never approves or captures it');
  assert.match(f.$('quote-content').textContent, /Sandbox test is in progress/);
  assert.match(f.$('notice').textContent, /capture is not verified/);
  assert.equal(f.$('quote-payment-badge').textContent, 'SANDBOX IN PROGRESS');
  const approved = { ...created, providerOrderStatus: 'APPROVED' };
  f.enqueue('/api/payments/test-operation-1/reconcile', json({ payment: approved }));
  await f.$('reconcile-sandbox-payment').click();
  assert.deepEqual(JSON.parse(f.calls.at(-1).options.body), {});
  assert.equal(f.calls.length, 3, 'reconciliation does not capture');
  assert.ok(f.$('capture-sandbox-payment'));
  f.enqueue('/api/payments/test-operation-1/capture', json({ payment: { ...approved,
    state: 'completed', providerOrderStatus: 'COMPLETED', captureId: 'SANDBOXCAPTURE123' } }));
  await f.$('capture-sandbox-payment').click();
  assert.deepEqual(JSON.parse(f.calls.at(-1).options.body), {});
  assert.match(f.$('payment-stage').textContent, /server verified a COMPLETED Sandbox capture/);
  assert.match(f.$('payment-stage').textContent, /SANDBOXCAPTURE123/);
  assert.equal(f.$('quote-payment-badge').textContent, 'SANDBOX CAPTURE VERIFIED');
  assert.match(f.$('quote-content').textContent, /server-verified Sandbox capture receipt/);
  assert.match(f.$('notice').textContent, /not a real-money payment/);
  assert.doesNotMatch(f.$('quote-content').textContent, /Payment has not started/);
  assert.equal(f.$('clear-button').disabled, false, 'only confirmed completion unlocks Clear');
  assert.equal(f.$('review-controls').disabled, true, 'the receipt keeps the original scope locked');
  assert.equal(f.$('capture-sandbox-payment'), null, 'completed captures cannot be repeated');
  assert.equal(f.$('reconcile-sandbox-payment'), null);
});

test('unknown or pending provider outcomes remain locked and offer reconciliation without a second capture', async t => {
  const record = records(), unknown = sandboxPayment(record.quote, {
    state: 'unknown', providerOrderStatus: null, lastIssue: 'transport_unknown' });
  const f = await harness(t, sandboxSession(record, unknown));
  assert.equal(f.$('clear-button').disabled, true);
  assert.equal(f.$('capture-sandbox-payment'), null);
  assert.equal(f.$('create-sandbox-payment'), null);
  assert.equal(f.$('sandbox-approval-link'), null);
  assert.match(f.$('payment-stage').textContent, /outcome is unknown/);
  f.enqueue('/api/payments/test-operation-1/reconcile', json({ payment: {
    ...unknown, state: 'capture_pending', lastIssue: 'provider_pending' } }));
  await f.$('reconcile-sandbox-payment').click();
  assert.equal(f.$('capture-sandbox-payment'), null);
  assert.equal(f.$('clear-button').disabled, true);
  assert.match(f.$('payment-stage').textContent, /not a completed test payment/);
  assert.equal(f.calls.length, 2);
});

test('a lost create response locks retries and Clear until an authoritative refresh', async t => {
  const record = records(), f = await harness(t, sandboxSession(record));
  await f.check('sandbox-consent');
  f.enqueue('/api/payments/create', () => { throw new TypeError('Controlled lost response'); });
  await f.$('create-sandbox-payment').click();
  assert.equal(f.$('clear-button').disabled, true);
  assert.equal(f.$('create-sandbox-payment'), null);
  assert.match(f.$('payment-stage').textContent, /outcome is unknown/);
  assert.equal(f.calls.length, 2, 'failed create does not automatically retry any mutation');
  f.enqueue('/api/session', json(sandboxSession(record, sandboxPayment(record.quote, {
    state: 'unknown', orderId: null, approvalUrl: null, providerOrderStatus: null }))));
  await f.$('refresh-session').click();
  assert.equal(f.$('clear-button').disabled, true);
  assert.equal(f.$('create-sandbox-payment'), null);
  assert.equal(f.$('capture-sandbox-payment'), null);
  assert.equal(f.$('reconcile-sandbox-payment'), null, 'an unknown operation without order ID needs server investigation');
  assert.match(f.$('payment-stage').textContent, /server-side investigation/);
});

test('a claimed completed payment without a capture ID is unverified and cannot unlock the workspace', async t => {
  const record = records(), invalid = sandboxPayment(record.quote, {
    state: 'completed', providerOrderStatus: 'COMPLETED', captureId: null });
  const f = await harness(t, sandboxSession(record, invalid));
  assert.equal(f.$('clear-button').disabled, true);
  assert.equal(f.$('review-controls').disabled, true);
  assert.equal(f.$('quote-payment-badge').textContent, 'SANDBOX UNVERIFIED');
  assert.equal(f.$('capture-sandbox-payment'), null);
  assert.match(f.$('payment-stage').textContent, /could not be verified/);
});

test('Sandbox approval links reject live, injected, mismatched and duplicate-token destinations', () => {
  const payment = sandboxPayment(records().quote);
  assert.equal(sandboxApprovalUrl(payment), payment.approvalUrl);
  for (const approvalUrl of [
    'https://www.paypal.com/checkoutnow?token=SANDBOXORDER123',
    'https://www.sandbox.paypal.com.evil.test/checkoutnow?token=SANDBOXORDER123',
    'javascript:alert(1)',
    'https://www.sandbox.paypal.com/checkoutnow?token=OTHERORDER',
    'https://www.sandbox.paypal.com/checkoutnow?token=SANDBOXORDER123&token=SANDBOXORDER123',
    'https://www.sandbox.paypal.com/checkoutnow?token=SANDBOXORDER123#approved',
  ]) assert.equal(sandboxApprovalUrl({ ...payment, approvalUrl }), null);
  const approved = { ...payment, providerOrderStatus: 'APPROVED' };
  assert.equal(canCapturePayment(approved, null), false, 'approval alone cannot skip manual reconciliation');
  assert.equal(canCapturePayment(approved, payment.id), true);
  assert.equal(validPayment({ ...payment, sandboxOnly: false }), false);
});

test('Sandbox boundaries, actions and recovery copy remain localized in Chinese and Japanese', async t => {
  const record = records(), f = await harness(t, sandboxSession(record));
  f.$('language').value = 'zh-Hant';await f.$('language').fire('change');
  assert.equal(f.$('create-sandbox-payment').textContent, '建立 Sandbox 測試訂單');
  assert.match(f.$('payment-stage').textContent, /不會產生真實購買/);
  f.$('language').value = 'ja';await f.$('language').fire('change');
  assert.equal(f.$('create-sandbox-payment').textContent, 'Sandbox テスト注文を作成');
  assert.match(f.$('payment-stage').textContent, /実際の購入/);
  f.$('language').value = 'en';await f.$('language').fire('change');
  assert.equal(f.calls.length, 1, 'switching languages makes no payment request');
});

for (const [name,extra,summaryKey,badgeKey] of [
  ['not started',null,'confirmedQuote','notPaid'],
  ['created',{state:'created'},'quoteSandboxInProgress','sandboxInProgress'],
  ['unknown',{state:'unknown',providerOrderStatus:null,lastIssue:'transport_unknown'},'quoteSandboxUnverified','sandboxUnverified'],
  ['verified completed',{state:'completed',providerOrderStatus:'COMPLETED',captureId:'SANDBOXCAPTURE123'},'quoteSandboxVerified','sandboxCaptured'],
  ['unverified completed',{state:'completed',providerOrderStatus:'COMPLETED',captureId:null},'quoteSandboxUnverified','sandboxUnverified'],
]) test(`quote and global Sandbox status agree after reload: ${name}, in all three languages`, async t => {
  const record=records(), payment=extra ? sandboxPayment(record.quote,extra):null;
  const f=await harness(t,sandboxSession(record,payment));
  for (const language of ['en','zh-Hant','ja']) {
    f.$('language').value=language;await f.$('language').fire('change');
    const summary=translatedText(summaryKey);
    assert.ok(f.$('quote-content').textContent.includes(summary),'quote has the matching payment summary');
    assert.ok(f.$('activity-status').textContent.includes(summary) || !payment,'activity summary matches an existing payment');
    if (payment) {
      assert.ok(f.$('notice').textContent.includes(summary),'session-ready notice includes current Sandbox outcome');
      assert.equal(f.$('draft-state').textContent,translatedText(badgeKey));
      assert.ok(!f.$('quote-content').textContent.includes(translatedText('confirmedQuote')),'started operations never claim payment has not started');
      assert.ok(!f.$('notice').textContent.includes(translatedText('confirmedQuote')),'global notice never carries the stale unstarted claim');
    }
    assert.equal(f.$('quote-payment-badge').textContent,translatedText(badgeKey));
  }
  assert.equal(record.quote.paymentStatus,'not_started','the immutable domain quote remains a preparation record');
  assert.equal(f.calls.length,1,'reloading and translating a receipt only reads the session; no new transaction starts');
  f.$('language').value='en';await f.$('language').fire('change');
});

test('pending AI can be cleared; late success cannot revive the draft or unlock a newer action', async t => {
  const f = await harness(t); const oldAi = deferred(); await f.startAi(oldAi);
  const clearing = deferred(); const { completion } = await f.clear(clearing);
  clearing.resolve(json(bootstrap({ csrf: 'b'.repeat(64), activity: { aiBusy: true, workspaceBusy: false } })));
  await completion;
  assert.equal(f.$('raw-brief').value, '');
  assert.equal(f.$('draft-workspace').hidden, true);
  assert.equal(f.$('clear-dialog').open, false);

  await f.enter('raw-brief', 'New manual brief.');
  const manual = deferred(); f.enqueue('/api/drafts', manual.promise);
  const manualCompletion = f.$('manual-button').click(); await tick();
  assert.equal(f.document.body.getAttribute('aria-busy'), 'true');
  oldAi.resolve(json({ draft: records().draft, extraction: { mode: 'ai' } }, 201)); await tick();
  assert.equal(f.$('raw-brief').value, 'New manual brief.');
  assert.equal(f.$('draft-workspace').hidden, true);
  assert.equal(f.document.body.getAttribute('aria-busy'), 'true', 'obsolete finally cannot end the new manual action');
  assert.equal(f.$('manual-button').disabled, true);
  for (const id of ['brief-controls', 'review-controls', 'quote-controls']) assert.equal(f.$(id).disabled, true, `${id} remains locked by the newer action`);
  const manualDraft = new ScopeBook().createDraft('controlled-ui-test', 'New manual brief.', { requestedRequirements: [], missingQuestions: [] });
  manual.resolve(json({ draft: manualDraft, extraction: { mode: 'manual' } }, 201));
  await manualCompletion; await tick();
  assert.equal(f.document.body.getAttribute('aria-busy'), 'false');
});

for (const [name, error] of [
  ['network error', new Error('Controlled late network failure')],
  ['abort/timeout outcome', Object.assign(new Error('Controlled late abort'), { name: 'AbortError' })],
]) test(`late AI ${name} cannot replace Clear success or unlock a newer Refresh`, async t => {
  const f = await harness(t); const oldAi = deferred(); await f.startAi(oldAi);
  const clearing = deferred(); const { completion } = await f.clear(clearing);
  clearing.resolve(json(bootstrap({ csrf: 'b'.repeat(64) }))); await completion;
  const notice = f.$('notice').dataset.message;
  const refreshing = deferred(); f.enqueue('/api/session', refreshing.promise);
  const refreshed = f.$('refresh-session').click(); await tick();
  oldAi.reject(error); await tick();
  assert.equal(f.$('notice').dataset.message, notice);
  assert.equal(f.$('raw-brief').value, '');
  assert.equal(f.$('draft-workspace').hidden, true);
  assert.equal(f.document.body.getAttribute('aria-busy'), 'true');
  assert.equal(f.$('refresh-session').disabled, true);
  for (const id of ['brief-controls', 'review-controls', 'quote-controls']) assert.equal(f.$(id).disabled, true, `${id} remains locked by Refresh`);
  refreshing.resolve(json(bootstrap({ csrf: 'b'.repeat(64) }))); await refreshed;
});

test('AI completion while Clear is pending cannot replace the clearing state', async t => {
  const f = await harness(t); const oldAi = deferred(); await f.startAi(oldAi);
  const clearing = deferred(); const { completion } = await f.clear(clearing);
  oldAi.resolve(json({ draft: records().draft, extraction: { mode: 'ai' } }, 201)); await tick();
  assert.equal(f.$('notice').dataset.message, 'clearing');
  assert.equal(f.$('draft-workspace').hidden, true);
  assert.equal(f.$('confirm-clear').disabled, true);
  assert.equal(f.document.body.getAttribute('aria-busy'), 'true');
  clearing.resolve(json(bootstrap({ csrf: 'b'.repeat(64) }))); await completion;
  assert.equal(f.$('raw-brief').value, '');
});

test('failed Clear makes one read-only reconciliation and does not retry AI or Clear', async t => {
  const f = await harness(t); const oldAi = deferred(); await f.startAi(oldAi);
  const clearing = deferred(); const { completion } = await f.clear(clearing);
  f.enqueue('/api/session', json(bootstrap({ activity: { aiBusy: true, workspaceBusy: true } })));
  clearing.reject(new Error('Controlled uncertain Clear response')); await completion;
  assert.deepEqual(f.calls.map(c => c.path), ['/api/session', '/api/drafts', '/api/clear', '/api/session']);
  assert.equal(f.$('notice').dataset.message, 'clearReconciled');
  assert.equal(f.$('raw-brief').value, 'Synthetic pending brief.');
  assert.equal(f.$('draft-workspace').hidden, true);
  oldAi.resolve(json({ draft: records().draft, extraction: { mode: 'ai' } }, 201)); await tick();
  assert.equal(f.$('draft-workspace').hidden, true, 'superseded extraction response remains ignored after failed Clear');
});

test('uncertain Clear and failed reconciliation preserve edits, block mutations, and recover by Refresh', async t => {
  const r = records(); const initial = bootstrap({ draft: r.confirmed, quote: r.quote, extraction: { mode: 'ai' } });
  const f = await harness(t, initial);
  await f.enter('scope-deliverables', '2');
  await f.enter('decision-0', 'correct'); await f.enter('decision-note-0', 'Human-approved scope correction.');
  await f.check('confirm-grounding'); await f.check('confirm-rights');
  const field = f.$('scope-deliverables'); const note = f.$('decision-note-0');
  const clearing = deferred(); const { completion } = await f.clear(clearing);
  f.enqueue('/api/session', () => { throw new Error('Controlled failed reconciliation'); });
  clearing.reject(new Error('Controlled Clear failure')); await completion;
  assert.equal(f.$('notice').dataset.message, 'clearUncertain');
  assert.equal(f.$('scope-deliverables'), field); assert.equal(field.value, '2');
  assert.equal(f.$('decision-note-0'), note); assert.equal(note.value, 'Human-approved scope correction.');
  assert.equal(f.$('confirm-grounding').checked, true); assert.equal(f.$('confirm-rights').checked, true);
  assert.equal(f.$('clear-dialog').open, false);
  for (const id of ['ai-button', 'manual-button', 'clear-button', 'save-review', 'confirm-quote']) assert.equal(f.$(id).disabled, true, `${id} cannot mutate an uncertain workspace`);
  assert.equal(f.$('refresh-session').disabled, false);
  assert.equal(f.$('quote-form').hidden, true);
  assert.equal(f.$('quote-content').textContent.includes(r.quote.id), false);
  f.enqueue('/api/session', json(initial)); await f.$('refresh-session').click();
  assert.equal(f.$('scope-deliverables'), field); assert.equal(field.value, '2');
  assert.equal(f.$('confirm-grounding').checked, true); assert.equal(f.$('confirm-rights').checked, true);
  assert.equal(f.$('save-review').disabled, false);
  assert.equal(f.$('quote-form').hidden, true, 'dirty local edits cannot display an old current quote after recovery');
});

test('failed Clear reconciles the same context without discarding dirty review controls or flags', async t => {
  const r = records(); const f = await harness(t, bootstrap({ draft: r.reviewed, extraction: { mode: 'ai' } }));
  await f.enter('scope-deliverables', '2');
  await f.enter('decision-0', 'correct'); await f.enter('decision-note-0', 'Keep this unsaved human correction.');
  await f.check('confirm-grounding'); await f.check('confirm-rights');
  const field = f.$('scope-deliverables'), note = f.$('decision-note-0');
  const clearing = deferred(); const { completion } = await f.clear(clearing);
  f.enqueue('/api/session', json(bootstrap({ draft: r.confirmed, quote: r.quote, extraction: { mode: 'ai' } })));
  clearing.reject(new Error('Controlled Clear response failure')); await completion;
  assert.deepEqual(f.calls.map(c => c.path), ['/api/session', '/api/clear', '/api/session']);
  assert.equal(f.$('notice').dataset.message, 'clearReconciled');
  assert.equal(f.$('scope-deliverables'), field); assert.equal(field.value, '2');
  assert.equal(f.$('decision-note-0'), note); assert.equal(note.value, 'Keep this unsaved human correction.');
  assert.equal(f.$('confirm-grounding').checked, true); assert.equal(f.$('confirm-rights').checked, true);
  assert.equal(f.$('draft-state').dataset.state, 'dirty');
  assert.equal(f.$('quote-form').hidden, true);
  assert.equal(f.$('quote-content').textContent.includes(r.quote.id), false);
});

test('same-version Refresh adopts a quote confirmed elsewhere without rebuilding review controls', async t => {
  const r = records(); const initial = bootstrap({ draft: r.reviewed, extraction: { mode: 'ai' } });
  const f = await harness(t, initial); const field = f.$('scope-deliverables');
  await f.check('confirm-grounding'); await f.check('confirm-rights');
  await f.check('confirm-scope'); await f.check('confirm-price');
  f.enqueue('/api/session', json(bootstrap({ draft: r.confirmed, quote: r.quote, extraction: { mode: 'ai' } })));
  await f.$('refresh-session').click();
  assert.equal(f.$('scope-deliverables'), field);
  assert.equal(f.$('confirm-grounding').checked, true); assert.equal(f.$('confirm-rights').checked, true);
  assert.equal(f.$('confirm-scope').checked, false); assert.equal(f.$('confirm-price').checked, false);
  assert.equal(f.$('draft-state').dataset.state, 'confirmed_quote');
  assert.equal(f.$('quote-content').textContent.includes(r.quote.id), true);
  assert.equal(f.$('quote-form').hidden, true);
});

test('same-version Refresh retains dirty scope, attribution notes and review flags while hiding the server quote', async t => {
  const r = records(); const f = await harness(t, bootstrap({ draft: r.reviewed, extraction: { mode: 'ai' } }));
  await f.enter('scope-deliverables', '2');
  await f.enter('decision-0', 'correct'); await f.enter('decision-note-0', 'Two clips after human review.');
  await f.check('confirm-grounding'); await f.check('confirm-rights');
  const field = f.$('scope-deliverables'), decision = f.$('decision-0'), note = f.$('decision-note-0');
  f.enqueue('/api/session', json(bootstrap({ draft: r.confirmed, quote: r.quote, extraction: { mode: 'ai' } })));
  await f.$('refresh-session').click();
  assert.equal(f.$('scope-deliverables'), field); assert.equal(field.value, '2');
  assert.equal(f.$('decision-0'), decision); assert.equal(decision.value, 'correct');
  assert.equal(f.$('decision-note-0'), note); assert.equal(note.value, 'Two clips after human review.');
  assert.equal(f.$('confirm-grounding').checked, true); assert.equal(f.$('confirm-rights').checked, true);
  assert.equal(f.$('draft-state').dataset.state, 'dirty');
  assert.equal(f.$('quote-form').hidden, true);
  assert.equal(f.$('quote-content').textContent.includes(r.quote.id), false);
});
