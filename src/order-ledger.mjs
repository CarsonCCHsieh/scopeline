import * as fs from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CATALOG_VERSION, findSku } from './catalog.mjs';
import { immutable } from './contract.mjs';

/**
 * Private, single-writer sandbox operation journal. No raw brief, payer, secret or
 * provider response is stored. Supply a stable PRIVATE runtime directory, never
 * a served/public directory. Owner strings are trusted-controller assertions, not
 * authentication. There is deliberately no Clear/delete/reset operation.
 *
 * Each transition fsyncs a new snapshot then atomically renames it. POSIX also
 * fsyncs the directory; Windows cannot promise power-loss directory durability.
 * A failed write poisons this instance: stop all payment work and reopen it.
 * Exclusive writer locks are NOT automatically broken. After process death an
 * operator must establish that no writer exists before removing .writer.lock.
 * Reopening converts interrupted creating/capture_pending intents to unknown.
 * This is process-restart persistence, not an encrypted or tamper-proof database.
 */
export class LedgerError extends Error {
  constructor(code, message) { super(message); this.name = 'LedgerError'; this.code = code; }
}
const fail = (code, message) => { throw new LedgerError(code, message); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const PROVIDER_ID = /^[A-Z0-9]{8,64}$/;
const isUuid = value => typeof value === 'string' && UUID.test(value);
const isHash = value => typeof value === 'string' && HASH.test(value);
const STATES = ['creating', 'created', 'capture_pending', 'completed', 'unknown'];
const REASONS = ['transport_unknown', 'provider_unverified', 'provider_pending', 'recovered_inflight'];
const NOW = () => new Date().toISOString();
const clone = value => JSON.parse(JSON.stringify(value));
const validOwner = owner => typeof owner === 'string' && owner.trim() && owner.length <= 200;
export const isProviderId = value => typeof value === 'string' && PROVIDER_ID.test(value);
const keysAre = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const QUOTE_KEYS = ['id', 'draftId', 'scopeVersion', 'reviewDigest', 'quoteDigest', 'catalogVersion', 'sku', 'totalCents', 'currency'];
const ENTRY_KEYS = ['id', 'environment', 'owner', 'quote', 'merchantId', 'createRequestId', 'captureRequestId', 'state',
  'orderId', 'captureId', 'captureStarted', 'providerOrderStatus', 'lastIssue', 'createdAt', 'updatedAt', 'completionEvidence'];

function validQuote(q) {
  const offer = findSku(q?.sku);
  return keysAre(q, QUOTE_KEYS) && isUuid(q.id) && isUuid(q.draftId)
    && Number.isSafeInteger(q.scopeVersion) && q.scopeVersion >= 2
    && isHash(q.reviewDigest) && isHash(q.quoteDigest) && q.catalogVersion === CATALOG_VERSION
    && offer && q.currency === 'USD' && q.currency === offer.currency
    && q.totalCents === offer.priceCents;
}
function quoteSnapshot(quote) {
  if (quote?.kind !== 'confirmed_scope_quote' || quote.sandboxOnly !== true || quote.paymentStatus !== 'not_started')
    fail('invalid_quote', 'A confirmed sandbox-only domain quote is required.');
  const q = { id: quote.id, draftId: quote.draftId, scopeVersion: quote.scopeVersion,
    reviewDigest: quote.reviewDigest, quoteDigest: quote.digest, catalogVersion: quote.catalogVersion,
    sku: quote.scope?.sku, totalCents: quote.totalCents, currency: quote.currency };
  if (!validQuote(q)) fail('invalid_quote', 'The quote must match the fixed catalog.');
  return q;
}
function validateEntries(entries) {
  if (!Array.isArray(entries) || entries.length > 1000) fail('ledger_corrupt', 'The journal is invalid or full.');
  const ids = new Set(), drafts = new Set(), orders = new Set(), requests = new Set();
  for (const e of entries) {
    const draftKey = JSON.stringify([e?.owner, e?.quote?.draftId]);
    if (!keysAre(e, ENTRY_KEYS) || !isUuid(e.id) || e.environment !== 'sandbox' || !validOwner(e.owner) || !validQuote(e.quote)
      || !isProviderId(e.merchantId) || !isUuid(e.createRequestId) || !isUuid(e.captureRequestId)
      || !STATES.includes(e.state) || (e.orderId !== null && !isProviderId(e.orderId))
      || (e.captureId !== null && !isProviderId(e.captureId)) || typeof e.captureStarted !== 'boolean'
      || ![null, 'CREATED', 'APPROVED', 'PAYER_ACTION_REQUIRED', 'COMPLETED'].includes(e.providerOrderStatus)
      || ![null, ...REASONS].includes(e.lastIssue) || !Number.isFinite(Date.parse(e.createdAt))
      || !Number.isFinite(Date.parse(e.updatedAt)) || ids.has(e.id) || drafts.has(draftKey)
      || requests.has(e.createRequestId) || requests.has(e.captureRequestId) || e.createRequestId === e.captureRequestId
      || (e.orderId && orders.has(e.orderId))) fail('ledger_corrupt', 'The journal contains invalid or duplicate records.');
    if (e.state === 'created' && (!e.orderId || e.captureStarted || !['CREATED', 'APPROVED', 'PAYER_ACTION_REQUIRED'].includes(e.providerOrderStatus)))
      fail('ledger_corrupt', 'A created record needs a verified order.');
    if (e.state === 'capture_pending' && (!e.orderId || !e.captureStarted)) fail('ledger_corrupt', 'A capture intent needs an order.');
    if (e.state === 'completed') {
      if (!e.orderId || !e.captureId || e.providerOrderStatus !== 'COMPLETED'
        || !keysAre(e.completionEvidence, ['orderStatus', 'captureStatus', 'verifiedAt'])
        || e.completionEvidence.orderStatus !== 'COMPLETED' || e.completionEvidence.captureStatus !== 'COMPLETED'
        || !Number.isFinite(Date.parse(e.completionEvidence.verifiedAt))) fail('ledger_corrupt', 'Completion evidence is missing.');
    } else if (e.completionEvidence !== null || e.captureId !== null) fail('ledger_corrupt', 'Unverified records cannot claim completion.');
    ids.add(e.id); drafts.add(draftKey); requests.add(e.createRequestId); requests.add(e.captureRequestId);
    if (e.orderId) orders.add(e.orderId);
  }
}

export class OrderLedger {
  #io; #directory; #file; #lock; #lease; #entries = []; #closed = false; #poisoned = false;

  /** io is a trusted filesystem seam for deterministic failure tests, not user input. */
  static open(directory, { io = fs } = {}) {
    if (typeof directory !== 'string' || !directory.trim()) fail('invalid_path', 'Supply a private runtime directory.');
    const ledger = new OrderLedger();
    ledger.#io = io; ledger.#directory = resolve(directory);
    ledger.#file = join(ledger.#directory, 'orders.json'); ledger.#lock = join(ledger.#directory, '.writer.lock');
    io.mkdirSync(ledger.#directory, { recursive: true, mode: 0o700 });
    if (!io.lstatSync(ledger.#directory).isDirectory() || io.lstatSync(ledger.#directory).isSymbolicLink())
      fail('invalid_path', 'The runtime directory must be a real directory.');
    ledger.#lease = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
    try {
      const fd = io.openSync(ledger.#lock, 'wx', 0o600);
      try { io.writeFileSync(fd, ledger.#lease); io.fsyncSync(fd); } finally { io.closeSync(fd); }
    } catch { fail('ledger_locked', 'Exclusive writer unavailable; do not automatically remove its lock.'); }
    try {
      if (io.existsSync(ledger.#file)) {
        const stat = io.lstatSync(ledger.#file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) fail('ledger_corrupt', 'Invalid journal file.');
        let data;
        try { data = JSON.parse(io.readFileSync(ledger.#file, 'utf8')); }
        catch { fail('ledger_corrupt', 'The journal cannot be decoded.'); }
        if (!keysAre(data, ['format', 'entries']) || data.format !== 1) fail('ledger_corrupt', 'Unknown journal format.');
        validateEntries(data.entries); ledger.#entries = data.entries;
        if (data.entries.some(e => ['creating', 'capture_pending'].includes(e.state))) {
          ledger.#write(data.entries.map(e => ['creating', 'capture_pending'].includes(e.state)
            ? { ...e, state: 'unknown', lastIssue: 'recovered_inflight', updatedAt: NOW() } : e));
        }
      } else ledger.#write([]);
      return ledger;
    } catch (error) { ledger.close(); throw error; }
  }

  #active() {
    if (this.#closed || this.#poisoned) fail('ledger_unavailable', 'Stop payment work and reopen the journal.');
    try { if (this.#io.readFileSync(this.#lock, 'utf8') !== this.#lease) throw new Error(); }
    catch { this.#poisoned = true; fail('ledger_unavailable', 'The exclusive writer lease was lost.'); }
  }
  #write(entries) {
    this.#active(); validateEntries(entries);
    const bytes = JSON.stringify({ format: 1, entries });
    if (Buffer.byteLength(bytes) > 1024 * 1024) fail('ledger_full', 'The journal limit was reached.');
    const temporary = join(this.#directory, `.orders-${randomUUID()}.tmp`);
    try {
      const fd = this.#io.openSync(temporary, 'wx', 0o600);
      try { this.#io.writeFileSync(fd, bytes); this.#io.fsyncSync(fd); } finally { this.#io.closeSync(fd); }
      this.#io.renameSync(temporary, this.#file);
      if (process.platform !== 'win32') {
        const dir = this.#io.openSync(this.#directory, 'r');
        try { this.#io.fsyncSync(dir); } finally { this.#io.closeSync(dir); }
      }
      this.#entries = clone(entries);
    } catch {
      this.#poisoned = true;
      fail('ledger_write_failed', 'Journal write uncertain; no further provider request is permitted.');
    } finally {
      try { this.#io.unlinkSync(temporary); } catch { /* Renamed or preserved until operator cleanup. */ }
    }
  }
  #owned(owner, id) {
    this.#active();
    const entry = this.#entries.find(e => e.id === id && e.owner === owner);
    if (!validOwner(owner) || !entry) fail('not_found', 'The operation is unavailable.');
    return entry;
  }
  #replace(owner, id, patch) {
    const current = this.#owned(owner, id);
    const next = { ...current, ...patch, updatedAt: NOW() };
    this.#write(this.#entries.map(e => e.id === id ? next : e));
    return immutable(clone(next));
  }
  get(owner, id) { return immutable(clone(this.#owned(owner, id))); }
  findForQuote(owner, quoteId) {
    this.#active();
    if (!validOwner(owner)) fail('not_found', 'The operation is unavailable.');
    const entry = this.#entries.find(e => e.owner === owner && e.quote.id === quoteId);
    return entry ? immutable(clone(entry)) : null;
  }
  findForDraft(owner, draftId) {
    this.#active();
    if (!validOwner(owner)) fail('not_found', 'The operation is unavailable.');
    const entry = this.#entries.find(e => e.owner === owner && e.quote.draftId === draftId);
    return entry ? immutable(clone(entry)) : null;
  }
  reserve(owner, quote, merchantId) {
    this.#active();
    if (!validOwner(owner) || !isProviderId(merchantId)) fail('invalid_owner_or_merchant', 'Trusted owner and sandbox merchant are required.');
    const snapshot = quoteSnapshot(quote);
    const existing = this.findForQuote(owner, snapshot.id);
    if (existing) {
      if (JSON.stringify(existing.quote) !== JSON.stringify(snapshot) || existing.merchantId !== merchantId)
        fail('quote_changed', 'An existing operation cannot change its pinned quote or merchant.');
      return { record: existing, created: false };
    }
    if (this.findForDraft(owner, snapshot.draftId)) fail('draft_locked', 'An order already pins this draft; use a separate draft for new scope.');
    const now = NOW();
    const entry = { id: randomUUID(), environment: 'sandbox', owner, quote: snapshot, merchantId,
      createRequestId: randomUUID(), captureRequestId: randomUUID(), state: 'creating', orderId: null,
      captureId: null, captureStarted: false, providerOrderStatus: null, lastIssue: null,
      createdAt: now, updatedAt: now, completionEvidence: null };
    this.#write([...this.#entries, entry]);
    return { record: immutable(clone(entry)), created: true };
  }
  attachOrder(owner, id, orderId) {
    const e = this.#owned(owner, id);
    if (!isProviderId(orderId) || (e.orderId !== null && e.orderId !== orderId)
      || this.#entries.some(other => other.id !== id && other.orderId === orderId)
      || !['creating', 'unknown'].includes(e.state)) fail('invalid_transition', 'The provider order cannot be rebound.');
    return this.#replace(owner, id, { orderId });
  }
  markCreated(owner, id, status) {
    const e = this.#owned(owner, id);
    if (!e.orderId || e.captureStarted || !['creating', 'created', 'unknown'].includes(e.state)
      || !['CREATED', 'APPROVED', 'PAYER_ACTION_REQUIRED'].includes(status)) fail('invalid_transition', 'This operation cannot return to a capturable state.');
    return this.#replace(owner, id, { state: 'created', providerOrderStatus: status, lastIssue: null });
  }
  startCapture(owner, id) {
    const e = this.#owned(owner, id);
    if (e.state !== 'created' || e.captureStarted || !e.orderId || e.providerOrderStatus !== 'APPROVED')
      fail('invalid_transition', 'A verified approved order is required before capture.');
    return this.#replace(owner, id, { state: 'capture_pending', captureStarted: true, lastIssue: null });
  }
  markUnknown(owner, id, reason) {
    const e = this.#owned(owner, id);
    if (e.state === 'completed' || !REASONS.includes(reason)) fail('invalid_transition', 'Invalid unknown-state transition.');
    return this.#replace(owner, id, { state: 'unknown', lastIssue: reason });
  }
  /** Only PaymentService's verified GET path should invoke this trusted seam. */
  complete(owner, id, captureId) {
    const e = this.#owned(owner, id);
    if (!e.orderId || !isProviderId(captureId) || e.state === 'completed') fail('invalid_transition', 'Invalid completion transition.');
    return this.#replace(owner, id, { state: 'completed', captureId, providerOrderStatus: 'COMPLETED', lastIssue: null,
      completionEvidence: { orderStatus: 'COMPLETED', captureStatus: 'COMPLETED', verifiedAt: NOW() } });
  }
  close() {
    if (this.#closed) return;
    try { if (this.#io.readFileSync(this.#lock, 'utf8') === this.#lease) this.#io.unlinkSync(this.#lock); } catch { /* Never remove another writer's lock. */ }
    this.#closed = true;
  }
}
