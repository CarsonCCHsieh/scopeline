import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as turn } from 'node:timers/promises';
import { createPayPalSandboxTransport } from '../src/paypal-sandbox.mjs';
import { PaymentError, PAYPAL_SANDBOX_ORIGIN as ORIGIN } from '../src/payment-service.mjs';

// 全部是合成憑證及注入的 fetch；不讀環境檔，也不發出 HTTP。
const CLIENT = 'FAKE_SANDBOX_CLIENT';
const SECRET = 'fake-private-client-secret';
const TOKEN = 'A21AA_SYNTHETIC_TOKEN';
const TOKEN_URL = `${ORIGIN}/v1/oauth2/token`;
const ORDER = 'ORDER123456';
const CAPTURE = 'CAPTURE12345';
const REQUEST_ID = '7bb5d8c1-51f9-4b95-8c43-8be8cc86af36';
const LIMIT = 128 * 1024;
const config = { clientId: CLIENT, clientSecret: SECRET, clock: () => 1000 };
const tokenBody = changes => ({ access_token: TOKEN, token_type: 'Bearer', expires_in: 3600, ...changes });
const json = (body, options = {}) => new Response(JSON.stringify(body), { ...options,
  headers: { 'Content-Type': 'application/json', ...options.headers } });
const get = (path = `/v2/checkout/orders/${ORDER}`, changes = {}) => ({ method: 'GET', url: ORIGIN + path,
  headers: { Accept: 'application/json' }, ...changes });
const post = (path = '/v2/checkout/orders', changes = {}) => ({ method: 'POST', url: ORIGIN + path,
  headers: { Accept: 'application/json', 'Content-Type': 'application/json', Prefer: 'return=representation',
    'PayPal-Request-Id': REQUEST_ID }, body: {}, ...changes });
const safeFailure = error => {
  assert.ok(error instanceof PaymentError);
  assert.equal(error.code, 'transport_unknown');
  assert.equal(error.message, 'Sandbox request failed; the provider outcome may be unknown.');
  assert.equal(error.cause, undefined);
  for (const value of [SECRET, TOKEN, 'RAW_PROVIDER_PRIVATE_DETAIL']) assert.equal(String(error.stack).includes(value), false);
  return true;
};
function fixture({ resource = () => json({ id: ORDER }), oauth = () => json(tokenBody()), clock = config.clock } = {}) {
  const calls = [];
  const transport = createPayPalSandboxTransport({ ...config, clock, fetchImpl: async (url, options) => {
    calls.push({ url, ...options });
    return url === TOKEN_URL ? oauth(url, options) : resource(url, options);
  } });
  return { transport, calls, tokens: () => calls.filter(call => call.url === TOKEN_URL),
    requests: () => calls.filter(call => call.url !== TOKEN_URL) };
}

test('factory stays idle, validates explicit configuration, and never reads or creates ambient credentials', () => {
  let calls = 0;
  const fetchImpl = () => { calls++; throw new Error('unexpected request'); };
  assert.equal(typeof createPayPalSandboxTransport({ ...config, fetchImpl }), 'function');
  for (const changes of [{ clientId: '' }, { clientId: 'wrong:id' }, { clientSecret: '' }, { clientSecret: 'line\nbreak' },
    { fetchImpl: null }, { clock: null }]) {
    assert.throws(() => createPayPalSandboxTransport({ ...config, fetchImpl, ...changes }), error => {
      assert.equal(error.code, 'invalid_configuration');
      assert.equal(error.message, 'Sandbox transport configuration is invalid.');
      return true;
    });
  }
  assert.equal(calls, 0);
});

test('OAuth and all four allowed operations use only fixed Sandbox URLs and constrained headers', async () => {
  const f = fixture({ resource: () => json({ id: ORDER }, { status: 201 }) });
  const body = { intent: 'CAPTURE', purchase_units: [{ reference_id: 'local-operation', amount: { currency_code: 'USD', value: '25.00' } }] };
  assert.deepEqual(await f.transport(post(undefined, { body })), { status: 201, body: { id: ORDER } });
  await f.transport(get());
  await f.transport(post(`/v2/checkout/orders/${ORDER}/capture`));
  await f.transport(get(`/v2/payments/captures/${CAPTURE}`));
  assert.equal(f.tokens().length, 1);
  const oauth = f.tokens()[0];
  assert.equal(oauth.method, 'POST');
  assert.equal(oauth.body, 'grant_type=client_credentials');
  assert.deepEqual(oauth.headers, { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded',
    Authorization: `Basic ${Buffer.from(`${CLIENT}:${SECRET}`).toString('base64')}` });
  const requests = f.requests();
  assert.equal(requests.length, 4);
  assert.equal(requests[0].body, JSON.stringify(body));
  assert.deepEqual(requests[0].headers, { Accept: 'application/json', 'Content-Type': 'application/json',
    Prefer: 'return=representation', 'PayPal-Request-Id': REQUEST_ID, Authorization: `Bearer ${TOKEN}` });
  assert.deepEqual(requests[1].headers, { Accept: 'application/json', Authorization: `Bearer ${TOKEN}` });
  assert.equal(requests[1].body, undefined);
  assert.equal(requests[2].body, '{}');
  assert.equal(requests[2].headers['PayPal-Request-Id'], REQUEST_ID);
  for (const call of f.calls) {
    assert.equal(new URL(call.url).origin, ORIGIN);
    assert.equal(call.redirect, 'error');
    assert.equal(call.credentials, 'omit');
    assert.equal(call.cache, 'no-store');
    assert.equal(call.referrerPolicy, 'no-referrer');
    assert.ok(call.signal instanceof AbortSignal);
  }
});

test('live, normalized or unlisted URLs and methods fail before OAuth', async () => {
  const f = fixture();
  const valid = `${ORIGIN}/v2/checkout/orders/${ORDER}`;
  for (const url of [valid.replace('.sandbox', ''), valid.replace('https:', 'http:'), valid.replace('https://', 'https://user:pass@'),
    valid.replace('.com/', '.com:443/'), `${valid}?x=1`, `${valid}#x`, `${valid}/`, `${valid}/capture`,
    `${ORIGIN}/x/../v2/checkout/orders/${ORDER}`, `${ORIGIN}/v2/checkout/orders/%4FRDER123456`,
    `${ORIGIN}/v2/checkout/orders/order123456`, `${ORIGIN}/v2/checkout/orders/SHORT`,
    `${ORIGIN}/v1/oauth2/token`, `${ORIGIN}/v2/checkout/orders`, `${ORIGIN}/v2/payments/captures/${CAPTURE}/refund`,
    `${ORIGIN}.evil.example/v2/checkout/orders/${ORDER}`, valid.replace('https://api', 'https://API')]) {
    await assert.rejects(f.transport(get(undefined, { url })), safeFailure);
  }
  for (const request of [get(undefined, { method: 'DELETE' }), get(undefined, { method: 'get' }),
    post(`/v2/payments/captures/${CAPTURE}`), post(`/v2/checkout/orders/${ORDER}`), post('/v2/checkout/orders', { redirect: 'follow' })]) {
    await assert.rejects(f.transport(request), safeFailure);
  }
  assert.equal(f.calls.length, 0);
});

test('caller authorization, cookies, header duplicates, invalid request IDs and mismatched bodies fail closed', async () => {
  const f = fixture();
  for (const name of ['Authorization', 'Host', 'Cookie', 'PayPal-Auth-Assertion', 'X-Forwarded-Host']) {
    await assert.rejects(f.transport(get(undefined, { headers: { Accept: 'application/json', [name]: SECRET } })), safeFailure);
  }
  for (const request of [get(undefined, { headers: { Accept: 'application/json', accept: 'application/json' } }),
    get(undefined, { headers: {} }), get(undefined, { headers: { Accept: 'text/html' } }), get(undefined, { body: {} }),
    get(undefined, { signal: { aborted: false } }), post(undefined, { body: 'RAW_PROVIDER_PRIVATE_DETAIL' }),
    post(undefined, { body: [] }), post(undefined, { headers: { ...post().headers, Prefer: 'return=minimal' } }),
    post(undefined, { headers: { ...post().headers, 'PayPal-Request-Id': 'not-a-stable-operation-id' } }),
    post(undefined, { headers: { ...post().headers, 'Content-Type': 'text/plain' } }),
    post(undefined, { body: { text: '界'.repeat(44_000) } })]) {
    await assert.rejects(f.transport(request), safeFailure);
  }
  assert.equal(f.calls.length, 0);
  await f.transport(post(undefined, { headers: { accept: 'APPLICATION/JSON', 'content-type': 'application/json',
    prefer: 'return=representation', 'paypal-request-id': REQUEST_ID } }));
  assert.equal(f.requests()[0].headers['PayPal-Request-Id'], REQUEST_ID);
});

test('tokens cache in this factory only, expire before provider expiry, cap at five minutes and reject clock rollback', async () => {
  let at = 1000;
  const f = fixture({ clock: () => at });
  await f.transport(get());
  await f.transport(get());
  at = 270_999;
  await f.transport(get());
  assert.equal(f.tokens().length, 1);
  at = 271_000;
  await f.transport(get());
  assert.equal(f.tokens().length, 2);
  at = 500;
  await f.transport(get());
  assert.equal(f.tokens().length, 3);
  const other = fixture({ clock: () => at });
  await other.transport(get());
  assert.equal(other.tokens().length, 1, 'a second factory cannot inherit credentials or token state');
  const short = fixture({ clock: () => at, oauth: () => json(tokenBody({ expires_in: 2 })) });
  await short.transport(get());
  at += 1799;
  await short.transport(get());
  assert.equal(short.tokens().length, 1);
  at++;
  await short.transport(get());
  assert.equal(short.tokens().length, 2);
});

test('simultaneous callers share one token refresh but keep distinct payment requests', async () => {
  let release;
  const f = fixture({ oauth: () => new Promise(resolve => { release = resolve; }) });
  const first = f.transport(post());
  const secondId = '29b318ce-13ac-4873-88a6-948e28bcc32d';
  const second = f.transport(post(`/v2/checkout/orders/${ORDER}/capture`, { headers: { ...post().headers, 'PayPal-Request-Id': secondId } }));
  await turn();
  assert.equal(f.tokens().length, 1);
  assert.equal(f.requests().length, 0);
  release(json(tokenBody()));
  await Promise.all([first, second]);
  assert.equal(f.requests().length, 2);
  assert.deepEqual(f.requests().map(call => call.headers['PayPal-Request-Id']), [REQUEST_ID, secondId]);
});

test('aborting one token waiter leaves another waiter alive; an abandoned refresh cannot populate the cache', async () => {
  let release;
  const controller = new AbortController();
  const f = fixture({ oauth: () => new Promise(resolve => { release = resolve; }) });
  const firstRejected = assert.rejects(f.transport(get(undefined, { signal: controller.signal })), safeFailure);
  const second = f.transport(get());
  await turn();
  controller.abort(new Error(SECRET));
  await firstRejected;
  assert.equal(f.tokens()[0].signal.aborted, false);
  release(json(tokenBody()));
  await second;
  assert.equal(f.requests().length, 1);

  let resolveAbandoned;
  let oauthCount = 0;
  const abandoned = fixture({ oauth: () => ++oauthCount === 1
    ? new Promise(resolve => { resolveAbandoned = resolve; }) : json(tokenBody()) });
  const only = new AbortController();
  const cancelled = assert.rejects(abandoned.transport(get(undefined, { signal: only.signal })), safeFailure);
  await turn();
  only.abort();
  await cancelled;
  assert.equal(abandoned.tokens()[0].signal.aborted, true);
  resolveAbandoned(json(tokenBody({ access_token: 'ABANDONED_TOKEN' })));
  await turn();
  await abandoned.transport(get());
  assert.equal(abandoned.tokens().length, 2);
  assert.equal(abandoned.requests()[0].headers.Authorization, `Bearer ${TOKEN}`);
});

test('401 invalidates only subsequent authentication and never repeats either payment POST', async () => {
  for (const request of [post(), post(`/v2/checkout/orders/${ORDER}/capture`)]) {
    let fail = true;
    const f = fixture({ resource: () => fail ? json({ detail: 'RAW_PROVIDER_PRIVATE_DETAIL' }, { status: 401 }) : json({ id: ORDER }) });
    await assert.rejects(f.transport(request), safeFailure);
    assert.equal(f.tokens().length, 1);
    assert.equal(f.requests().length, 1);
    fail = false;
    await f.transport(get());
    assert.equal(f.tokens().length, 2);
    assert.deepEqual(f.requests().map(call => call.method), ['POST', 'GET']);
  }
});

test('fetch failures, OAuth failures and malformed tokens never leak provider details or retry', async () => {
  for (const oauth of [() => { throw new Error(`${SECRET} ${TOKEN} RAW_PROVIDER_PRIVATE_DETAIL`); },
    () => json(tokenBody(), { status: 401 }), () => json(tokenBody({ token_type: 'MAC' })),
    () => json(tokenBody({ expires_in: 0 })), () => json(tokenBody({ expires_in: '3600' })),
    () => json(tokenBody({ expires_in: 1.5 })), () => json(tokenBody({ access_token: 'bad\r\nheader' })),
    () => json(tokenBody({ access_token: 'x'.repeat(4097) }))]) {
    const f = fixture({ oauth });
    await assert.rejects(f.transport(post()), safeFailure);
    assert.equal(f.calls.length, 1);
    assert.equal(f.requests().length, 0);
  }
  const f = fixture({ resource: () => { throw new Error(`${SECRET} RAW_PROVIDER_PRIVATE_DETAIL`); } });
  await assert.rejects(f.transport(post()), safeFailure);
  assert.equal(f.requests().length, 1);
  assert.equal(f.requests()[0].signal.aborted, true);
});

test('redirect flags, response URLs and redirect status fail closed for OAuth and resource responses', async () => {
  const wrongResponses = body => [
    () => Object.defineProperty(json(body), 'redirected', { value: true }),
    () => Object.defineProperty(json(body), 'url', { value: 'https://api-m.paypal.com/v2/checkout/orders' }),
    () => Object.defineProperty(json(body), 'url', { value: `${ORIGIN}/v2/checkout/orders?redirect=1` }),
    () => Object.defineProperty(json(body), 'url', { value: `${ORIGIN}/other` }),
    () => json(body, { status: 307, headers: { Location: 'https://example.test/' } }),
    () => Object.defineProperty(json(body), 'type', { value: 'opaqueredirect' }),
  ];
  for (const make of wrongResponses(tokenBody())) {
    const f = fixture({ oauth: make });
    await assert.rejects(f.transport(post()), safeFailure);
    assert.equal(f.calls.length, 1);
  }
  for (const make of wrongResponses({ id: ORDER })) {
    const f = fixture({ resource: make });
    await assert.rejects(f.transport(post()), safeFailure);
    assert.equal(f.requests().length, 1);
    assert.equal(f.requests()[0].signal.aborted, true);
  }
  const correct = fixture({ oauth: () => Object.defineProperty(json(tokenBody()), 'url', { value: TOKEN_URL }),
    resource: () => Object.defineProperty(json({ id: ORDER }), 'url', { value: ORIGIN + `/v2/checkout/orders/${ORDER}` }) });
  assert.equal((await correct.transport(get())).status, 200);
});

test('both response paths enforce JSON, UTF-8 and actual 128KiB stream bytes even when length is absent or lies', async () => {
  const invalid = [
    () => new Response('RAW_PROVIDER_PRIVATE_DETAIL', { headers: { 'Content-Type': 'application/json' } }),
    () => json({ private: SECRET }, { headers: { 'Content-Type': 'text/html' } }),
    () => json({}, { headers: { 'Content-Length': String(LIMIT + 1) } }),
    () => json({}, { headers: { 'Content-Length': 'invalid' } }),
    () => json({ text: '界'.repeat(44_000) }),
    () => json({ text: 'x'.repeat(LIMIT) }, { headers: { 'Content-Length': '1' } }),
    () => new Response(new Uint8Array([0xc3, 0x28]), { headers: { 'Content-Type': 'application/json' } }),
    () => json([]),
  ];
  for (const make of invalid) {
    const oauth = fixture({ oauth: make });
    await assert.rejects(oauth.transport(post()), safeFailure);
    assert.equal(oauth.calls.length, 1);
    const resource = fixture({ resource: make });
    await assert.rejects(resource.transport(post()), safeFailure);
    assert.equal(resource.requests().length, 1);
  }
  const edgeBody = { value: 'x'.repeat(LIMIT - Buffer.byteLength(JSON.stringify({ value: '' }))) };
  const edge = fixture({ resource: () => json(edgeBody) });
  assert.equal(Buffer.byteLength(JSON.stringify((await edge.transport(get())).body)), LIMIT);
});

test('stream overflow cancels reading before EOF without waiting for further chunks', async () => {
  let cancelled = 0;
  const f = fixture({ resource: () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{"text":"'));
    controller.enqueue(new Uint8Array(LIMIT).fill(0x61));
  }, cancel() { cancelled++; } }), { headers: { 'Content-Type': 'application/json' } }) });
  await assert.rejects(f.transport(post()), safeFailure);
  assert.equal(cancelled, 1);
  assert.equal(f.requests().length, 1);
  assert.equal(f.requests()[0].signal.aborted, true);
});

test('pre-aborted input sends nothing and an in-flight abort terminates an uncooperative resource fetch', async () => {
  const before = new AbortController(); before.abort();
  const idle = fixture();
  await assert.rejects(idle.transport(post(undefined, { signal: before.signal })), safeFailure);
  assert.equal(idle.calls.length, 0);
  const controller = new AbortController();
  const f = fixture({ resource: () => new Promise(() => {}) });
  const rejected = assert.rejects(f.transport(post(undefined, { signal: controller.signal })), safeFailure);
  await turn();
  controller.abort(new Error('RAW_PROVIDER_PRIVATE_DETAIL'));
  await rejected;
  assert.equal(f.requests().length, 1);
  assert.equal(f.requests()[0].signal.aborted, true);
});

test('fixed deadline stops an uncooperative OAuth fetch and allows a fresh explicit request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let count = 0;
  const f = fixture({ oauth: () => ++count === 1 ? new Promise(() => {}) : json(tokenBody()) });
  const rejected = assert.rejects(f.transport(post()), safeFailure);
  await turn();
  assert.equal(f.tokens().length, 1);
  t.mock.timers.tick(20_000);
  await rejected;
  assert.equal(f.tokens()[0].signal.aborted, true);
  assert.equal(f.requests().length, 0);
  await f.transport(get());
  assert.equal(f.tokens().length, 2);
  assert.equal(f.requests().length, 1);
});

test('OAuth time consumes the same overall deadline rather than granting the order another twenty seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release;
  const f = fixture({ oauth: () => new Promise(resolve => { release = resolve; }), resource: () => new Promise(() => {}) });
  const rejected = assert.rejects(f.transport(post()), safeFailure);
  await turn();
  t.mock.timers.tick(19_999);
  release(json(tokenBody()));
  await turn();
  assert.equal(f.requests().length, 1);
  assert.equal(f.requests()[0].signal.aborted, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(f.requests()[0].signal.aborted, true);
  assert.equal(f.requests().length, 1);
});

test('a failed shared refresh rejects every waiter and only a later explicit call can try OAuth again', async () => {
  let release;
  let attempts = 0;
  const f = fixture({ oauth: () => ++attempts === 1 ? new Promise(resolve => { release = resolve; }) : json(tokenBody()) });
  const first = assert.rejects(f.transport(post()), safeFailure);
  const second = assert.rejects(f.transport(get()), safeFailure);
  await turn();
  release(json({ detail: 'RAW_PROVIDER_PRIVATE_DETAIL' }, { status: 503 }));
  await Promise.all([first, second]);
  assert.equal(f.tokens().length, 1);
  assert.equal(f.requests().length, 0);
  await f.transport(get());
  assert.equal(f.tokens().length, 2);
  assert.equal(f.requests().length, 1);
});

test('fixed deadline stops a stalled resource POST once, including an uncooperative body reader and cancel', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let cancelCalls = 0;
  let releaseCalls = 0;
  const stalledReader = { read: () => new Promise(() => {}), cancel: () => { cancelCalls++; return new Promise(() => {}); },
    releaseLock: () => { releaseCalls++; } };
  for (const resource of [() => new Promise(() => {}), () => ({ status: 200, url: '', redirected: false,
    headers: new Headers({ 'Content-Type': 'application/json' }), body: { getReader: () => stalledReader } })]) {
    const f = fixture({ resource });
    const rejected = assert.rejects(f.transport(post()), safeFailure);
    await turn();
    t.mock.timers.tick(20_000);
    await rejected;
    assert.equal(f.requests().length, 1);
    assert.equal(f.requests()[0].signal.aborted, true);
  }
  assert.equal(cancelCalls, 1);
  assert.equal(releaseCalls, 1);
});

test('unusable clocks and token responses already older than their lifetime cannot authorize an order', async () => {
  for (const clock of [() => NaN, () => Infinity, () => { throw new Error(SECRET); }]) {
    const f = fixture({ clock });
    await assert.rejects(f.transport(post()), safeFailure);
    assert.equal(f.calls.length, 0);
  }
  let at = 1000;
  const f = fixture({ clock: () => at, oauth: () => { at += 2000; return json(tokenBody({ expires_in: 1 })); } });
  await assert.rejects(f.transport(post()), safeFailure);
  assert.equal(f.tokens().length, 1);
  assert.equal(f.requests().length, 0);
});
