import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { ScopeBook } from './domain.mjs';
import { CATALOG, CATALOG_VERSION, SYSTEM_RESTRICTIONS, catalogConflicts, findSku } from './catalog.mjs';
import { DomainError, FIELDS, boundedText, record, validateValue } from './contract.mjs';
import { createLocalExtractor, DraftAiError, MAX_BRIEF_CHARS, MODEL } from './ai/ollama.mjs';
import { PaymentService, PaymentError } from './payment-service.mjs';
import { LedgerError, isProviderId } from './order-ledger.mjs';

const COOKIE = 'scopeline_session';
const BODY_LIMIT = 32768;
const DEFAULT_PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const token = () => randomBytes(32).toString('hex');
class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const deny = (status, code, message) => { throw new HttpError(status, code, message); };
const constantEqual = (a, b) => typeof a === 'string' && typeof b === 'string'
  && /^[0-9a-f]{64}$/.test(a) && /^[0-9a-f]{64}$/.test(b)
  && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function readJson(req) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) {
    deny(415, 'json_required', 'Send a JSON request body.');
  }
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') deny(415, 'encoding_unsupported', 'Compressed request bodies are not accepted.');
  const declared = req.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > BODY_LIMIT)) deny(413, 'body_too_large', 'The request body exceeds its limit.');
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const cleanup = () => {
      clearTimeout(timer);
      req.removeListener('data', data);
      req.removeListener('end', end);
      req.removeListener('aborted', aborted);
    };
    const fail = error => { cleanup(); req.pause(); reject(error); };
    const data = chunk => {
      size += chunk.length;
      if (size > BODY_LIMIT) return fail(new HttpError(413, 'body_too_large', 'The request body exceeds its limit.'));
      chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try { resolve(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))); }
      catch { reject(new HttpError(400, 'invalid_json', 'The request body must be valid UTF-8 JSON.')); }
    };
    const aborted = () => fail(new HttpError(400, 'request_aborted', 'The request was interrupted.'));
    const timer = setTimeout(() => fail(new HttpError(408, 'body_timeout', 'The request body took too long.')), 5000);
    req.on('data', data);
    req.on('end', end);
    req.on('aborted', aborted);
    // Errors are intentionally not logged: a request can contain a private brief.
    req.on('error', aborted);
  });
}

/** Loopback-only anonymous workspace. Cookie possession is not an account login.
 * Payment routes are absent by default; a trusted launcher must explicitly inject
 * the private sandbox ledger/merchant/transport. No live or fulfillment support.
 */
export function createScopeServer({ extractor = createLocalExtractor(), publicDir = DEFAULT_PUBLIC,
  clock = Date.now, sessionIdleMs = 45 * 60000, sessionMaxMs = 8 * 3600000,
  maxSessions = 32, requestLimit = 90, extractLimit = 2, payments = null } = {}) {
  if (typeof extractor?.extractDraft !== 'function' || typeof clock !== 'function'
    || ![sessionIdleMs, sessionMaxMs, maxSessions, requestLimit, extractLimit].every(n => Number.isSafeInteger(n) && n > 0)) throw new TypeError('Invalid server options.');
  if (payments !== null && (!isProviderId(payments.merchantId) || typeof payments.transport !== 'function'
    || !['findForDraft', 'get'].every(key => typeof payments.ledger?.[key] === 'function'))) throw new TypeError('Invalid private sandbox configuration.');
  const sessions = new Map();
  // Browser cookies are host/path scoped, not port scoped. Keep local instances separate.
  const cookieName = () => `${COOKIE}_${server.address().port}`;
  let aiBusy = false;
  const expired = s => clock() - s.lastSeen >= sessionIdleMs || clock() - s.created >= sessionMaxMs;
  const revoke = s => { s.revoked = true; sessions.delete(s.id); s.book = null; s.draftId = null; s.quoteId = null; s.extraction = null; };
  const collect = () => { for (const s of sessions.values()) if (expired(s)) revoke(s); };
  const createSession = res => {
    collect();
    if (sessions.size >= maxSessions) deny(503, 'workspace_limit', 'The local workspace limit has been reached.');
    const s = { id: token(), owner: randomUUID(), csrf: token(), created: clock(), lastSeen: clock(),
      book: new ScopeBook(), draftId: null, quoteId: null, extraction: null,
      pending: false, paymentBusy: false, paymentService: null, revoked: false, requests: [], extractions: [] };
    sessions.set(s.id, s);
    res.setHeader('Set-Cookie', `${cookieName()}=${s.id}; HttpOnly; SameSite=Strict; Path=/`);
    return s;
  };
  const sessionFrom = req => {
    const name = cookieName();
    const values = (req.headers.cookie ?? '').split(';').map(x => x.trim()).filter(x => x.startsWith(name + '='));
    if (values.length !== 1) return null;
    const id = values[0].slice(name.length + 1);
    if (!/^[0-9a-f]{64}$/.test(id)) return null;
    const s = sessions.get(id);
    if (s && expired(s)) { revoke(s); return null; }
    return s ?? null;
  };
  const rate = (s, key, limit) => {
    s[key] = s[key].filter(t => clock() - t < 60000);
    if (s[key].length >= limit) deny(429, 'rate_limited', 'Too many requests. Wait before trying again.');
    s[key].push(clock());
  };
  const operation = s => payments && s.draftId ? payments.ledger.findForDraft(s.owner, s.draftId) : null;
  // URLs are constructed from a verified journal identity, never followed from
  // untrusted links or accepted from a browser. A return query proves nothing.
  const paymentView = entry => entry ? ({ id: entry.id, quoteId: entry.quote.id, state: entry.state,
    orderId: entry.orderId, captureId: entry.captureId, providerOrderStatus: entry.providerOrderStatus,
    lastIssue: entry.lastIssue, sandboxOnly: true, locked: true,
    amount: { currency: entry.quote.currency, value: (entry.quote.totalCents / 100).toFixed(2) },
    approvalUrl: entry.state === 'created' && ['CREATED', 'PAYER_ACTION_REQUIRED'].includes(entry.providerOrderStatus)
      ? `https://www.sandbox.paypal.com/checkoutnow?token=${entry.orderId}` : null,
  }) : null;
  const paymentGuard = s => {
    if (s.paymentBusy) deny(409, 'payment_busy', 'A sandbox payment action is still running. Check its status before continuing.');
    if (operation(s)) deny(409, 'payment_locked', 'This draft is pinned to a sandbox operation. Resolve it, then clear the workspace for a different scope.');
  };
  const view = s => ({ csrf: s.csrf, catalogVersion: CATALOG_VERSION, catalog: CATALOG,
    systemRestrictions: SYSTEM_RESTRICTIONS,
    capabilities: { localAi: true, paypal: payments !== null, persistence: 'session-memory' },
    activity: { aiBusy, workspaceBusy: s.pending || s.paymentBusy },
    payment: paymentView(operation(s)),
    extraction: s.extraction,
    draft: s.draftId ? s.book.getDraft(s.owner, s.draftId) : null,
    quote: s.quoteId ? s.book.getCurrentQuote(s.owner, s.quoteId) : null });
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const address = server.address();
      if (!address || typeof address === 'string' || address.address !== '127.0.0.1') deny(503, 'loopback_required', 'Run this workspace on 127.0.0.1 only.');
      const host = `127.0.0.1:${address.port}`;
      const origin = `http://${host}`;
      if (req.headers.host !== host) deny(403, 'host_forbidden', 'This host is not allowed.');
      const url = new URL(req.url, origin);
      if (url.origin !== origin || url.username || url.password) deny(400, 'invalid_path', 'Invalid request path.');
      const checkoutReturn = req.method === 'GET' && ['/paypal/return', '/paypal/cancel'].includes(url.pathname);
      if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']) && !checkoutReturn) deny(403, 'cross_site_forbidden', 'Cross-site access is not allowed.');
      if (checkoutReturn) {
        // Cross-site navigation is allowed only for this fixed inert receipt.
        // Ignore all provider query data: no ownership, approval or capture here.
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>SCOPELINE Sandbox return</title><body><h1>Return to SCOPELINE</h1><p>This return is not proof of payment. Use your original workspace to check the sandbox order, then explicitly request capture.</p><a href="/">Open the local workspace</a></body></html>');
      }
      if (url.pathname.startsWith('/api/')) {
        let s = sessionFrom(req);
        if (req.method === 'GET' && url.pathname === '/api/session') {
          s ??= createSession(res);
          rate(s, 'requests', requestLimit);
          s.lastSeen = clock();
          return json(res, 200, view(s));
        }
        if (!s) deny(401, 'session_required', 'Open the workspace again to create a session.');
        if (req.method !== 'POST') deny(405, 'method_not_allowed', 'This route requires POST.');
        if (req.headers.origin !== origin) deny(403, 'origin_forbidden', 'A same-origin action is required.');
        if (!constantEqual(req.headers['x-csrf-token'], s.csrf)) deny(403, 'csrf_required', 'Reload the workspace before trying this action.');
        rate(s, 'requests', requestLimit);
        s.lastSeen = clock();
        const body = await readJson(req);
        // A slow body can outlive expiry or race with Clear in another tab.
        if (s.revoked || expired(s) || sessions.get(s.id) !== s) deny(409, 'session_changed', 'The workspace changed. Reload it before continuing.');
        if (url.pathname === '/api/clear') {
          record(body, []);
          const pinned = operation(s);
          if (s.paymentBusy || (pinned && pinned.state !== 'completed')) deny(409, 'payment_locked', 'An unresolved sandbox operation is retained. Reconcile it before clearing this workspace.');
          revoke(s);
          const fresh = createSession(res);
          return json(res, 200, view(fresh));
        }
        if (s.pending) deny(429, 'workspace_busy', 'A draft extraction is still running. You can clear this workspace.');
        if (url.pathname === '/api/payments/create' || /^\/api\/payments\/[0-9a-f-]{36}\/(?:capture|reconcile)$/.test(url.pathname)) {
          if (!payments) deny(503, 'paypal_disabled', 'PayPal Sandbox is not enabled for this local server.');
          if (s.paymentBusy) deny(409, 'payment_busy', 'A sandbox payment action is still running. Check its status before continuing.');
          const create = url.pathname === '/api/payments/create';
          if (create) {
            record(body, ['quoteId']);
            if (body.quoteId !== s.quoteId || !s.quoteId) deny(404, 'not_found', 'The current quote is unavailable.');
          } else record(body, []);
          const match = /^\/api\/payments\/([0-9a-f-]{36})\/(capture|reconcile)$/.exec(url.pathname);
          if (!create) payments.ledger.get(s.owner, match[1]); // Ownership before network work.
          s.paymentService ??= new PaymentService({ ...payments, book: s.book, checkoutOrigin: origin });
          s.paymentBusy = true;
          try {
            const entry = create ? await s.paymentService.createOrder(s.owner, s.quoteId)
              : match[2] === 'capture' ? await s.paymentService.captureOrder(s.owner, match[1])
                : await s.paymentService.reconcile(s.owner, match[1]);
            // A session may expire while a durable operation is in flight. The
            // journal survives, but the expired browser gets no operation data.
            if (s.revoked || expired(s) || sessions.get(s.id) !== s) deny(409, 'session_changed', 'The session expired. The sandbox operation remains in the private journal for reconciliation.');
            return json(res, 200, { payment: paymentView(entry) });
          } finally { s.paymentBusy = false; }
        }
        if (url.pathname === '/api/drafts') {
          paymentGuard(s);
          record(body, ['rawBrief', 'mode']);
          boundedText(body.rawBrief, MAX_BRIEF_CHARS, 'invalid_brief');
          if (!['ai', 'manual'].includes(body.mode)) deny(422, 'invalid_mode', 'Choose AI extraction or explicit manual entry.');
          let extraction = { requestedRequirements: [], missingQuestions: [] };
          let metadata = { mode: 'manual', status: 'manual_entry', requiresHumanReview: true };
          if (body.mode === 'ai') {
            if (aiBusy) deny(429, 'ai_busy', 'Another local extraction is running. Try again after it finishes.');
            rate(s, 'extractions', extractLimit);
            aiBusy = true;
            s.pending = true;
            try {
              const result = await extractor.extractDraft(body.rawBrief);
              extraction = result.draft;
              metadata = { mode: 'ai', model: MODEL, status: 'unverified_draft', requiresHumanReview: true };
              if (Number.isFinite(result.metadata?.elapsedMs)) metadata.elapsedMs = result.metadata.elapsedMs;
            } finally { s.pending = false; aiBusy = false; }
            if (s.revoked || expired(s) || sessions.get(s.id) !== s || res.destroyed) deny(409, 'session_changed', 'The workspace changed while extraction was running. Its result was discarded.');
          }
          const book = new ScopeBook();
          const draft = book.createDraft(s.owner, body.rawBrief, extraction);
          s.book = book; s.paymentService = null; s.draftId = draft.id; s.quoteId = null; s.extraction = metadata;
          return json(res, 201, { draft, extraction: metadata });
        }
        const match = /^\/api\/drafts\/([0-9a-f-]{36})\/(review-preview|review|quote)$/.exec(url.pathname);
        if (!match || match[1] !== s.draftId) deny(404, 'not_found', 'The requested record is unavailable.');
        const [, id, action] = match;
        if (action === 'review-preview') {
          record(body, ['expectedVersion', 'scope']);
          const draft = s.book.getDraft(s.owner, id);
          if (body.expectedVersion !== draft.version) deny(409, 'stale_version', 'The draft changed. Reload its current version.');
          record(body.scope, Object.keys(FIELDS), []);
          for (const [field, value] of Object.entries(body.scope)) validateValue(field, value, { nullable: true });
          const previous = draft.review?.scope ?? Object.fromEntries(draft.requestedRequirements.map(p => [p.field, p.value]));
          return json(res, 200, { missingFields: Object.keys(FIELDS).filter(f => !Object.hasOwn(body.scope, f)),
            catalogComparisonStatus: body.scope.sku === undefined ? 'sku_missing' : findSku(body.scope.sku) ? 'compared' : 'sku_unsupported',
            catalogConflicts: catalogConflicts(body.scope),
            changes: Object.keys(body.scope).filter(f => body.scope[f] !== previous[f]).map(field => ({ field, before: previous[field] ?? null, after: body.scope[field] })) });
        }
        if (action === 'review') {
          paymentGuard(s);
          const draft = s.book.reviewDraft(s.owner, id, body);
          s.quoteId = null;
          return json(res, 200, { draft });
        }
        paymentGuard(s);
        const quote = s.book.confirmQuote(s.owner, id, body);
        s.quoteId = quote.id;
        return json(res, 200, { quote });
      }
      if (!['GET', 'HEAD'].includes(req.method)) deny(405, 'method_not_allowed', 'This route requires GET.');
      const path = url.pathname === '/' ? '/index.html' : url.pathname;
      if (!/^\/[A-Za-z0-9_-]+\.(?:html|css|mjs)$/.test(path)) deny(404, 'not_found', 'The requested page is unavailable.');
      const file = join(publicDir, path.slice(1));
      let bytes;
      try { if (!(await lstat(file)).isFile()) throw new Error(); bytes = await readFile(file); }
      catch { deny(404, 'not_found', 'The requested page is unavailable.'); }
      const type = path.endsWith('.css') ? 'text/css' : path.endsWith('.mjs') ? 'text/javascript' : 'text/html';
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Content-Length': bytes.length });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      if (!req.complete) res.setHeader('Connection', 'close');
      if (error instanceof HttpError) return json(res, error.status, { error: { code: error.code, message: error.message } });
      if (error instanceof DomainError) {
        const status = error.code === 'not_found' ? 404 : error.code.startsWith('stale_') ? 409 : 422;
        return json(res, status, { error: { code: error.code, message: error.message } });
      }
      if (error instanceof DraftAiError) {
        const code = ['ai_busy', 'ai_timeout', 'ai_unavailable', 'invalid_ai_response'].includes(error.code) ? error.code : 'ai_unavailable';
        return json(res, code === 'ai_busy' ? 429 : 503, { error: { code, message: 'Local AI extraction did not complete. Your brief has not been converted into a quote or payment.' } });
      }
      if (error instanceof PaymentError || error instanceof LedgerError) {
        const code = error.code === 'not_found' ? 'not_found' : error.code.startsWith('stale_') ? 'stale_quote'
          : ['draft_locked', 'quote_changed', 'merchant_changed'].includes(error.code) ? 'payment_locked' : 'ledger_unavailable';
        return json(res, code === 'not_found' ? 404 : ['stale_quote', 'payment_locked'].includes(code) ? 409 : 503,
          { error: { code, message: 'The sandbox operation could not be confirmed. Check its retained status; do not create a replacement payment.' } });
      }
      return json(res, 500, { error: { code: 'server_error', message: 'The action did not complete. Any uncertain sandbox operation remains retained; check its status before continuing.' } });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 40;
  const cleanup = setInterval(collect, Math.min(60000, sessionIdleMs));
  cleanup.unref();
  server.on('close', () => { clearInterval(cleanup); for (const s of sessions.values()) revoke(s); });
  return server;
}
