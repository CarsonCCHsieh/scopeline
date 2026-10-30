import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createScopeServer } from '../src/server.mjs';
import { DraftAiError } from '../src/ai/ollama.mjs';

const empty = () => ({ draft: { requestedRequirements: [], missingQuestions: [] }, metadata: { elapsedMs: 1 } });
const finalScope = () => ({ sku: 'clip_pack', deliverables: 3, secondsPerDeliverable: 30,
  captionsLanguage: 'English', aspectRatio: '9:16', revisions: 1, deliveryDays: 5,
  deliveryStarts: 'source_receipt', sourceReady: false, musicRights: 'none', publishRequested: false });
const review = (draft, scope = finalScope()) => ({ expectedVersion: draft.version, scope,
  decisions: draft.requestedRequirements.map(p => ({ field: p.field,
    decision: p.value === scope[p.field] ? 'accept' : 'correct', note: p.value === scope[p.field] ? '' : 'I explicitly accept this catalog alternative.' })),
  resolutions: draft.catalogConflicts.map(c => ({ conflictId: c.id, action: 'accept_catalog_terms', note: 'I accept the stated catalog terms.' })),
  confirmSourceGrounding: true, confirmRights: true });
const quote = draft => ({ expectedVersion: draft.version, reviewDigest: draft.review?.digest,
  confirmScope: true, acceptCatalogPrice: true, expectedTotalCents: 9000 });

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'scopeline-http-'));
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>HTTP fixture</title>');
  const server = createScopeServer({ publicDir: dir, extractor: { extractDraft: async () => empty() }, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); await rm(dir, { recursive: true }); });
  const bootstrap = async () => {
    const response = await fetch(base + '/api/session');
    const body = await response.json();
    assert.equal(response.status, 200);
    return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: body.csrf, body };
  };
  const send = async (s, path, value, extra = {}) => {
    const headers = { Cookie: s.cookie, Origin: base, 'X-CSRF-Token': s.csrf, 'Content-Type': 'application/json', ...extra.headers };
    const response = await fetch(base + path, { method: 'POST', body: typeof value === 'string' ? value : JSON.stringify(value), ...extra, headers });
    return { status: response.status, body: await response.json(), response };
  };
  const current = async s => {
    const response = await fetch(base + '/api/session', { headers: { Cookie: s.cookie } });
    return { response, body: await response.json() };
  };
  return { server, base, bootstrap, send, current };
}
const manual = async (f, s) => (await f.send(s, '/api/drafts', { rawBrief: 'Owner-authored synthetic clip brief.', mode: 'manual' })).body.draft;

test('HTTP bootstrap isolates anonymous workspaces and marks payment unavailable', async t => {
  const f = await fixture(t); const a = await f.bootstrap(); const b = await f.bootstrap();
  assert.notEqual(a.cookie, b.cookie); assert.notEqual(a.csrf, b.csrf);
  assert.deepEqual(a.body.capabilities, { localAi: true, paypal: false, persistence: 'session-memory' });
  assert.equal(a.body.draft, null); assert.equal(a.body.quote, null);
  const response = await fetch(f.base + '/api/session');
  assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Path=\//);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('HTTP rejects DNS-rebinding hosts and cross-site reads before revealing workspace data', async t => {
  const f = await fixture(t);
  const result = await new Promise((resolve, reject) => {
    const req = http.get(f.base + '/api/session', { headers: { Host: 'attacker.invalid' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
  });
  assert.equal(result, 403);
  const cross = await fetch(f.base + '/api/session', { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(cross.status, 403); assert.equal(cross.headers.get('access-control-allow-origin'), null);
});

test('HTTP cookie names keep two loopback ports from replacing each other in a browser cookie jar', async t => {
  const first = await fixture(t); const second = await fixture(t);
  const a = await first.bootstrap(); const draft = await manual(first, a);
  const response = await fetch(second.base + '/api/session', { headers: { Cookie: a.cookie } });
  const secondCookie = response.headers.get('set-cookie').split(';')[0];
  assert.notEqual(a.cookie.split('=')[0], secondCookie.split('=')[0]);
  const combined = { cookie: a.cookie + '; ' + secondCookie };
  const returned = await first.current(combined);
  assert.equal(returned.body.draft.id, draft.id); assert.equal(returned.body.csrf, a.csrf);
  assert.equal((await second.current(combined)).body.draft, null);
});

test('HTTP mutations require same-origin JSON and the current CSRF token', async t => {
  const f = await fixture(t); const a = await f.bootstrap();
  const body = { rawBrief: 'Synthetic.', mode: 'manual' };
  for (const [headers, status] of [
    [{ Origin: 'https://attacker.invalid' }, 403],
    [{ 'X-CSRF-Token': '' }, 403],
    [{ 'X-CSRF-Token': 'x'.repeat(64) }, 403],
    [{ 'Content-Type': 'text/plain' }, 415],
    [{ 'Content-Encoding': 'gzip' }, 415],
  ]) assert.equal((await f.send(a, '/api/drafts', body, { headers })).status, status);
  assert.equal((await f.send(a, '/api/drafts', '{bad')).status, 400);
  assert.equal((await f.send(a, '/api/drafts', { ...body, owner: 'other' })).status, 422);
  assert.equal((await f.current(a)).body.draft, null);
});

test('HTTP rejects oversized input and never silently falls back from failed AI to manual', async t => {
  let calls = 0;
  const f = await fixture(t, { extractor: { extractDraft: async () => { calls++; throw new DraftAiError('ai_unavailable', 'private diagnostic must not leak'); } } });
  const a = await f.bootstrap();
  assert.equal((await f.send(a, '/api/drafts', { rawBrief: 'x'.repeat(2001), mode: 'ai' })).status, 422);
  assert.equal(calls, 0);
  const huge = await f.send(a, '/api/drafts', { rawBrief: 'x'.repeat(40000), mode: 'manual' });
  assert.equal(huge.status, 413);
  const failed = await f.send(a, '/api/drafts', { rawBrief: 'Synthetic brief.', mode: 'ai' });
  assert.equal(failed.status, 503); assert.doesNotMatch(JSON.stringify(failed.body), /private diagnostic/);
  assert.equal(calls, 1); assert.equal((await f.current(a)).body.draft, null);
  const explicit = await f.send(a, '/api/drafts', { rawBrief: 'Synthetic brief.', mode: 'manual' });
  assert.equal(explicit.status, 201); assert.equal(explicit.body.extraction.mode, 'manual'); assert.equal(calls, 1);
});

test('HTTP extractor interface with an injected fake creates only an unverified draft, never a quote', async t => {
  let calls = 0;
  const f = await fixture(t, { extractor: { extractDraft: async raw => { calls++; assert.equal(raw, '3 clips'); return { draft: { requestedRequirements: [{ field: 'deliverables', value: 3, evidence: { start: 0, end: 7, quote: '3 clips' } }], missingQuestions: [] }, metadata: { elapsedMs: 42, diagnostic: 'excluded' } }; } } });
  const a = await f.bootstrap();
  const made = await f.send(a, '/api/drafts', { rawBrief: '3 clips', mode: 'ai' });
  assert.equal(made.status, 201); assert.equal(calls, 1);
  assert.equal(made.body.draft.state, 'draft'); assert.equal(made.body.draft.catalogComparisonStatus, 'sku_missing');
  assert.equal(made.body.draft.missingFields.length, 10); assert.equal(made.body.extraction.mode, 'ai');
  assert.equal(made.body.extraction.elapsedMs, 42); assert.equal(made.body.extraction.diagnostic, undefined);
  assert.equal((await f.current(a)).body.quote, null);
});

test('HTTP incomplete review and cross-workspace IDs fail without changing stored draft', async t => {
  const f = await fixture(t); const a = await f.bootstrap(); const b = await f.bootstrap(); const d = await manual(f, a);
  const path = `/api/drafts/${d.id}/review`;
  assert.equal((await f.send(b, path, review(d))).status, 404);
  const invalid = review(d); delete invalid.scope.sourceReady;
  assert.equal((await f.send(a, path, invalid)).status, 422);
  assert.equal((await f.current(a)).body.draft.version, 1);
  assert.equal((await f.send(a, `/api/drafts/${d.id}/quote`, quote(d))).status, 422);
});

test('HTTP preview preserves partial missing fields and recomputes conflicts without saving', async t => {
  const f = await fixture(t); const a = await f.bootstrap(); const d = await manual(f, a);
  const path = `/api/drafts/${d.id}/review-preview`;
  const missing = await f.send(a, path, { expectedVersion: 1, scope: { deliverables: 6 } });
  assert.equal(missing.status, 200); assert.equal(missing.body.catalogComparisonStatus, 'sku_missing');
  const compared = await f.send(a, path, { expectedVersion: 1, scope: { sku: 'clip_pack', deliverables: 6, revisions: 3 } });
  assert.equal(compared.body.catalogConflicts.length, 2);
  assert.equal(compared.body.missingFields.length, 8);
  assert.equal((await f.current(a)).body.draft.version, 1);
  assert.equal((await f.send(a, path, { expectedVersion: 2, scope: {} })).status, 409);
});

test('HTTP reviewed fixed-price quote is idempotent, stale on later review, and never paid', async t => {
  const f = await fixture(t); const a = await f.bootstrap(); const d = await manual(f, a);
  const path = `/api/drafts/${d.id}`;
  const reviewed = (await f.send(a, path + '/review', review(d))).body.draft;
  assert.equal(reviewed.version, 2);
  const wrong = { ...quote(reviewed), expectedTotalCents: 1 };
  assert.equal((await f.send(a, path + '/quote', wrong)).status, 422);
  const one = (await f.send(a, path + '/quote', quote(reviewed))).body.quote;
  const same = (await f.send(a, path + '/quote', quote(reviewed))).body.quote;
  assert.equal(one.id, same.id); assert.equal(one.totalCents, 9000); assert.equal(one.paymentStatus, 'not_started');
  const next = await f.send(a, path + '/review', review(reviewed));
  assert.equal(next.status, 200); assert.equal(next.body.draft.version, 3);
  assert.equal((await f.current(a)).body.quote, null);
  assert.equal((await f.send(a, path + '/quote', quote(reviewed))).status, 409);
  assert.equal((await f.send(a, '/api/payments/capture', { paid: true })).status, 404);
});

test('HTTP Clear rotates session/CSRF and prevents an in-flight AI result from resurrecting data', async t => {
  let release; let entered;
  const began = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { extractor: { extractDraft: async () => { entered(); return pending; } } });
  const a = await f.bootstrap();
  const oldRequest = f.send(a, '/api/drafts', { rawBrief: 'Synthetic pending brief.', mode: 'ai' });
  await began;
  const cleared = await f.send(a, '/api/clear', {});
  assert.equal(cleared.status, 200); assert.equal(cleared.body.draft, null);
  assert.equal(cleared.body.activity.aiBusy, true);
  const nextCookie = cleared.response.headers.get('set-cookie').split(';')[0];
  assert.notEqual(nextCookie, a.cookie); assert.notEqual(cleared.body.csrf, a.csrf);
  release(empty());
  assert.equal((await oldRequest).status, 409);
  const after = (await f.current({ cookie: nextCookie })).body;
  assert.equal(after.draft, null); assert.equal(after.activity.aiBusy, false);
  assert.equal((await f.send(a, '/api/clear', {})).status, 401);
});

test('HTTP serializes local inference across sessions without automatically retrying', async t => {
  let release; let entered; let calls = 0;
  const began = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { extractor: { extractDraft: async () => { calls++; entered(); return pending; } } });
  const a = await f.bootstrap(); const b = await f.bootstrap();
  const first = f.send(a, '/api/drafts', { rawBrief: 'Synthetic one.', mode: 'ai' }); await began;
  assert.equal((await f.send(b, '/api/drafts', { rawBrief: 'Synthetic two.', mode: 'ai' })).status, 429);
  assert.equal((await f.send(a, '/api/drafts', { rawBrief: 'Synthetic three.', mode: 'manual' })).status, 429);
  release(empty()); assert.equal((await first).status, 201); assert.equal(calls, 1);
});

test('HTTP inactive and absolute session expiry discard workspace records', async t => {
  let now = 1000;
  const f = await fixture(t, { clock: () => now, sessionIdleMs: 100, sessionMaxMs: 250 });
  const a = await f.bootstrap(); await manual(f, a);
  now += 101;
  assert.equal((await f.send(a, '/api/clear', {})).status, 401);
  const b = await f.bootstrap();
  now += 90; await f.current(b); now += 90; await f.current(b); now += 71;
  assert.equal((await f.send(b, '/api/clear', {})).status, 401);
});

test('HTTP enforces workspace/extraction bounds and serves no private or source files', async t => {
  const f = await fixture(t, { maxSessions: 1, extractLimit: 1 });
  const a = await f.bootstrap();
  assert.equal((await fetch(f.base + '/api/session')).status, 503);
  const body = { rawBrief: 'Synthetic.', mode: 'ai' };
  assert.equal((await f.send(a, '/api/drafts', body)).status, 201);
  assert.equal((await f.send(a, '/api/drafts', body)).status, 429);
  const page = await fetch(f.base + '/');
  assert.equal(page.status, 200); assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  for (const path of ['/.private/receipt.json', '/src/server.mjs', '/%2e%2e/package.json']) assert.equal((await fetch(f.base + path)).status, 404);
});
