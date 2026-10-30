import { Buffer } from 'node:buffer';
import { PaymentError, PAYPAL_SANDBOX_ORIGIN } from './payment-service.mjs';

const TOKEN_URL = `${PAYPAL_SANDBOX_ORIGIN}/v1/oauth2/token`;
const MAX_JSON_BYTES = 128 * 1024;
const DEADLINE_MS = 20_000;
const MAX_TOKEN_TTL_MS = 300_000;
const PROVIDER_ID = '[A-Z0-9]{8,64}';
const GET_PATH = new RegExp(`^/(?:v2/checkout/orders/${PROVIDER_ID}|v2/payments/captures/${PROVIDER_ID})$`);
const POST_PATH = new RegExp(`^/v2/checkout/orders(?:/${PROVIDER_ID}/capture)?$`);
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const failure = () => new PaymentError('transport_unknown', 'Sandbox request failed; the provider outcome may be unknown.');
const utf8Bytes = value => Buffer.byteLength(value, 'utf8');

// 外部 signal 與固定 deadline 都能結束等待，即使注入的 fetch／reader 忽略中止。
function deadline(parentSignal) {
  const controller = new AbortController();
  const stopped = new Promise((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(failure()), { once: true });
  });
  // 已中止、尚未開始等待的情況也不能留下未處理的拒絕。
  stopped.catch(() => {});
  const abort = () => controller.abort();
  const timer = setTimeout(abort, DEADLINE_MS);
  parentSignal?.addEventListener('abort', abort, { once: true });
  if (parentSignal?.aborted) abort();
  return {
    signal: controller.signal, abort,
    async run(work) {
      if (controller.signal.aborted) throw failure();
      return Promise.race([stopped, Promise.resolve().then(() => {
        if (controller.signal.aborted) throw failure();
        return work();
      })]);
    },
    close() { clearTimeout(timer); parentSignal?.removeEventListener('abort', abort); abort(); },
  };
}

function validateRequest(request) {
  if (!object(request) || Reflect.ownKeys(request).some(key => !['method', 'url', 'headers', 'body', 'signal'].includes(key))) throw failure();
  const { method, url, headers, body, signal } = request;
  if (typeof url !== 'string' || !url.startsWith(`${PAYPAL_SANDBOX_ORIGIN}/`)
    || !['GET', 'POST'].includes(method) || (signal !== undefined && !(signal instanceof AbortSignal))) throw failure();
  const path = url.slice(PAYPAL_SANDBOX_ORIGIN.length);
  // 比對原始字串，不讓 URL 正規化隱藏 port、dot segment、編碼、query 或 userinfo。
  if (!(method === 'GET' ? GET_PATH : POST_PATH).test(path) || !object(headers)) throw failure();
  const allowed = method === 'GET' ? ['accept'] : ['accept', 'content-type', 'prefer', 'paypal-request-id'];
  const normalized = {};
  for (const name of Reflect.ownKeys(headers)) {
    if (typeof name !== 'string' || !allowed.includes(name.toLowerCase()) || Object.hasOwn(normalized, name.toLowerCase())
      || typeof headers[name] !== 'string') throw failure();
    normalized[name.toLowerCase()] = headers[name];
  }
  if (Object.keys(normalized).length !== allowed.length || normalized.accept.toLowerCase() !== 'application/json') throw failure();
  const outgoing = { Accept: 'application/json' };
  if (method === 'POST') {
    if (normalized['content-type'].toLowerCase() !== 'application/json' || normalized.prefer !== 'return=representation'
      || !REQUEST_ID.test(normalized['paypal-request-id']) || !object(body)) throw failure();
    Object.assign(outgoing, { 'Content-Type': 'application/json', Prefer: 'return=representation',
      'PayPal-Request-Id': normalized['paypal-request-id'] });
    const serialized = JSON.stringify(body);
    if (typeof serialized !== 'string' || utf8Bytes(serialized) > MAX_JSON_BYTES) throw failure();
    return { method, url, headers: outgoing, body: serialized, signal };
  }
  if (body !== undefined) throw failure();
  return { method, url, headers: outgoing, signal };
}

async function jsonResponse(response, expectedUrl, scope) {
  let reader;
  try {
    if (!response || response.redirected || response.type === 'opaqueredirect' || typeof response.url !== 'string'
      || (response.url !== '' && response.url !== expectedUrl) || !Number.isInteger(response.status)
      || response.status < 200 || response.status >= 300) throw failure();
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) throw failure();
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_JSON_BYTES)) throw failure();
    if (!response.body || typeof response.body.getReader !== 'function') throw failure();
    reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await scope.run(() => reader.read());
      if (done) break;
      if (!(value instanceof Uint8Array) || (size += value.byteLength) > MAX_JSON_BYTES) throw failure();
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!object(body)) throw failure();
    return body;
  } finally {
    // cancel 本身也可能永不回應；不讓清理延長付款的未知結果等待。
    if (reader) {
      try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {}
      try { reader.releaseLock(); } catch {}
    }
  }
}

/**
 * 明確建立後才具備 Sandbox HTTP 能力；不讀環境檔、不自動接到伺服器。
 * 僅記憶體保存 token，最多五分鐘並扣除安全餘量；所有 HTTP 都不重試。
 * 官方協定：developer.paypal.com/api/rest/authentication/ 與
 * developer.paypal.com/api/rest/reference/idempotency/（2026-10-30 由主代理核對）。
 */
export function createPayPalSandboxTransport({ clientId, clientSecret, fetchImpl = globalThis.fetch, clock = Date.now } = {}) {
  if (typeof clientId !== 'string' || !/^[A-Za-z0-9._-]{1,1024}$/.test(clientId)
    || typeof clientSecret !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(clientSecret)
    || typeof fetchImpl !== 'function' || typeof clock !== 'function')
    throw new PaymentError('invalid_configuration', 'Sandbox transport configuration is invalid.');
  const basic = `Basic ${Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')}`;
  let cached = null;
  let pending = null;
  const now = () => { const value = clock(); if (!Number.isFinite(value)) throw failure(); return value; };
  const fetchJson = async (url, options, scope) => {
    const response = await scope.run(() => fetchImpl(url, { ...options, redirect: 'error', credentials: 'omit',
      cache: 'no-store', referrerPolicy: 'no-referrer', signal: scope.signal }));
    return { status: response.status, body: await jsonResponse(response, url, scope) };
  };
  function refresh() {
    const scope = deadline();
    const flight = { scope, waiters: 0, settled: false, promise: null };
    flight.promise = (async () => {
      const acquiredAt = now();
      const response = await fetchJson(TOKEN_URL, { method: 'POST', headers: {
        Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', Authorization: basic,
      }, body: 'grant_type=client_credentials' }, scope);
      const value = response.body;
      if (scope.signal.aborted || typeof value.access_token !== 'string' || !/^[A-Za-z0-9._~+/-]+=*$/.test(value.access_token)
        || value.access_token.length > 4096 || typeof value.token_type !== 'string' || value.token_type.toLowerCase() !== 'bearer'
        || !Number.isSafeInteger(value.expires_in) || value.expires_in <= 0) throw failure();
      const ttl = Math.min(value.expires_in * 1000, MAX_TOKEN_TTL_MS);
      const token = { value: value.access_token, acquiredAt, expiresAt: acquiredAt + ttl - Math.min(30_000, ttl / 10) };
      const receivedAt = now();
      if (receivedAt < acquiredAt || receivedAt >= token.expiresAt) throw failure();
      cached = token;
      return token;
    })().catch(() => { throw failure(); }).finally(() => {
      flight.settled = true; scope.close(); if (pending === flight) pending = null;
    });
    // 所有 caller 同時中止時，shared flight 仍須有拒絕處理器。
    flight.promise.catch(() => {});
    pending = flight;
    return flight;
  }
  async function tokenFor(scope) {
    if (scope.signal.aborted) throw failure();
    const at = now();
    if (cached && at >= cached.acquiredAt && at < cached.expiresAt) return cached;
    cached = null;
    const flight = pending ?? refresh();
    flight.waiters++;
    try { return await scope.run(() => flight.promise); }
    finally {
      flight.waiters--;
      if (flight.waiters === 0 && !flight.settled) {
        flight.scope.abort(); if (pending === flight) pending = null;
      }
    }
  }
  return async function transport(request) {
    let scope;
    try {
      const validated = validateRequest(request);
      scope = deadline(validated.signal);
      const token = await tokenFor(scope);
      const response = await scope.run(() => fetchImpl(validated.url, {
        method: validated.method, headers: { ...validated.headers, Authorization: `Bearer ${token.value}` },
        ...(validated.body === undefined ? {} : { body: validated.body }), redirect: 'error', credentials: 'omit',
        cache: 'no-store', referrerPolicy: 'no-referrer', signal: scope.signal,
      }));
      // 401 僅使後續明確操作重新取得 token，絕不重新送出本次 POST 或 GET。
      if (response?.status === 401 && cached === token) cached = null;
      const body = await jsonResponse(response, validated.url, scope);
      return { status: response.status, body };
    } catch { throw failure(); }
    finally { scope?.close(); }
  };
}
