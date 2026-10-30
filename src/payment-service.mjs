import { isProviderId, LedgerError } from './order-ledger.mjs';

/**
 * The HTTP controller supplies an explicitly enabled sandbox-only adapter;
 * this service never reads credentials. The adapter injects transport({method,url,headers,
 * body?,signal}) -> {status,body}, authenticates ONLY the fixed sandbox origin,
 * bounds/parses JSON and obeys the deadline. Tests inject synthetic responses.
 * Transport provenance cannot be established by checking JSON schema alone.
 *
 * Official protocol sources (read 2026-10-30):
 * https://developer.paypal.com/api/orders/v2/
 * https://developer.paypal.com/api/payments/v2/captures-get/
 * https://developer.paypal.com/api/rest/reference/idempotency/
 * UUID request IDs are distinct per operation. PayPal's retention is finite
 * (normally six hours), so this service NEVER automatically repeats a POST.
 * Unknown create without order ID requires manual reconciliation; no public
 * GET-by-request-ID exists. Clear must never replace/delete the stable ledger.
 *
 * ScopeBook remains independently mutable: every controller must consult the
 * ledger draft lock before review edits. Checks here prevent starting capture
 * from a stale quote; an already sent request belongs to its pinned old quote.
 */
export const PAYPAL_SANDBOX_ORIGIN = 'https://api-m.sandbox.paypal.com';
export class PaymentError extends Error {
  constructor(code, message) { super(message); this.name = 'PaymentError'; this.code = code; }
}
const fail = (code, message) => { throw new PaymentError(code, message); };
const amount = cents => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
function cents(value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,9})(?:\.[0-9]{1,2})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const total = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(total) ? total : null;
}
const sameMoney = (money, record) => money?.currency_code === record.quote.currency && cents(money?.value) === record.quote.totalCents;
const ok = response => Number.isInteger(response?.status) && response.status >= 200 && response.status < 300;

function verifyOrder(body, record) {
  if (body?.id !== record.orderId || body.intent !== 'CAPTURE' || !Array.isArray(body.purchase_units)
    || body.purchase_units.length !== 1) fail('provider_unverified', 'Provider order identity or intent was not verified.');
  const unit = body.purchase_units[0];
  if (unit.reference_id !== record.id || unit.invoice_id !== record.id || unit.custom_id !== record.quote.id
    || unit.payee?.merchant_id !== record.merchantId || !sameMoney(unit.amount, record))
    fail('provider_unverified', 'Provider order does not match the pinned quote and merchant.');
  if (!['CREATED', 'APPROVED', 'PAYER_ACTION_REQUIRED', 'COMPLETED'].includes(body.status))
    fail('provider_unverified', 'Provider order is not in a supported verified state.');
  return unit;
}
function verifyCapture(body, record, captureId) {
  if (body?.id !== captureId || body.status !== 'COMPLETED' || body.final_capture !== true
    || !sameMoney(body.amount, record) || body.payee?.merchant_id !== record.merchantId
    || body.supplementary_data?.related_ids?.order_id !== record.orderId)
    fail('provider_unverified', 'Capture completion, amount, merchant and order relation were not verified.');
}

export class PaymentService {
  #ledger; #book; #merchant; #transport; #timeout; #checkoutOrigin; #running = new Map();
  constructor({ ledger, book, merchantId, transport, timeoutMs = 20000, checkoutOrigin = null }) {
    if (!ledger || typeof book?.getCurrentQuote !== 'function' || !isProviderId(merchantId)
      || typeof transport !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
      fail('invalid_configuration', 'A private ledger, current-quote guard, sandbox merchant and trusted transport are required.');
    if (checkoutOrigin !== null && (typeof checkoutOrigin !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(checkoutOrigin)
      || new URL(checkoutOrigin).port === '' || Number(new URL(checkoutOrigin).port) > 65535))
      fail('invalid_configuration', 'Checkout must return to the trusted loopback server.');
    this.#ledger = ledger; this.#book = book; this.#merchant = merchantId; this.#transport = transport; this.#timeout = timeoutMs;
    this.#checkoutOrigin = checkoutOrigin;
  }
  #run(owner, id, action) {
    const key = JSON.stringify([owner, id]);
    if (this.#running.has(key)) return this.#running.get(key);
    // Schedule after registration so concurrent calls in this instance share work.
    const promise = Promise.resolve().then(action).finally(() => this.#running.delete(key));
    this.#running.set(key, promise); return promise;
  }
  async #request(method, path, { requestId, body } = {}) {
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => {
      controller.abort(); reject(new PaymentError('transport_unknown', 'Provider outcome is unknown.'));
    }, this.#timeout); });
    try {
      const headers = { Accept: 'application/json', ...(method === 'POST' ? {
        'Content-Type': 'application/json', Prefer: 'return=representation', 'PayPal-Request-Id': requestId } : {}) };
      return await Promise.race([Promise.resolve().then(() => this.#transport({ method,
        url: PAYPAL_SANDBOX_ORIGIN + path, headers, ...(body === undefined ? {} : { body }), signal: controller.signal })), deadline]);
    } finally { clearTimeout(timer); }
  }
  #unknown(owner, id, error) {
    // A persistence failure must escape, never be reclassified as a network error.
    if (error instanceof LedgerError) throw error;
    return this.#ledger.markUnknown(owner, id, error?.code === 'provider_unverified' ? 'provider_unverified' : 'transport_unknown');
  }
  #current(owner, record) {
    const quote = this.#book.getCurrentQuote(owner, record.quote.id);
    if (quote.digest !== record.quote.quoteDigest || quote.reviewDigest !== record.quote.reviewDigest
      || quote.scopeVersion !== record.quote.scopeVersion || quote.totalCents !== record.quote.totalCents
      || quote.currency !== record.quote.currency) fail('stale_quote', 'The current quote differs from the pinned quote.');
  }
  createOrder(owner, quoteId) {
    return this.#run(owner, quoteId, async () => {
      const existing = this.#ledger.findForQuote(owner, quoteId);
      if (existing) {
        if (existing.merchantId !== this.#merchant) fail('merchant_changed', 'The pinned merchant cannot change.');
        return existing; // Includes unknown: never allocate another request ID or POST.
      }
      const quote = this.#book.getCurrentQuote(owner, quoteId);
      const { record, created } = this.#ledger.reserve(owner, quote, this.#merchant);
      if (!created) return record;
      try {
        const response = await this.#request('POST', '/v2/checkout/orders', { requestId: record.createRequestId,
          body: { intent: 'CAPTURE', purchase_units: [{ reference_id: record.id, invoice_id: record.id,
            custom_id: record.quote.id, payee: { merchant_id: record.merchantId },
            amount: { currency_code: record.quote.currency, value: amount(record.quote.totalCents) } }],
            ...(this.#checkoutOrigin ? { payment_source: { paypal: { experience_context: {
              brand_name: 'SCOPELINE Sandbox', user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING',
              return_url: this.#checkoutOrigin + '/paypal/return', cancel_url: this.#checkoutOrigin + '/paypal/cancel',
            } } } } : {}) } });
        if (!ok(response) || !isProviderId(response.body?.id)) fail('provider_unverified', 'Create order did not yield a verified candidate ID.');
        this.#ledger.attachOrder(owner, record.id, response.body.id);
        return await this.#reconcile(owner, record.id);
      } catch (error) { return this.#unknown(owner, record.id, error); }
    });
  }
  reconcile(owner, operationId) { return this.#run(owner, operationId, () => this.#reconcile(owner, operationId)); }
  async #reconcile(owner, operationId) {
    const record = this.#ledger.get(owner, operationId);
    if (record.merchantId !== this.#merchant) fail('merchant_changed', 'The pinned merchant cannot change.');
    if (record.state === 'completed' || record.orderId === null) return record;
    try {
      const response = await this.#request('GET', `/v2/checkout/orders/${record.orderId}`);
      if (!ok(response)) fail('provider_unverified', 'Order lookup did not verify the result.');
      const unit = verifyOrder(response.body, record);
      if (response.body.status !== 'COMPLETED') {
        if (!record.captureStarted && !(unit.payments?.captures?.length))
          return this.#ledger.markCreated(owner, operationId, response.body.status);
        return this.#ledger.markUnknown(owner, operationId, 'provider_pending');
      }
      const captures = unit.payments?.captures;
      if (!Array.isArray(captures) || captures.length !== 1 || !isProviderId(captures[0]?.id))
        fail('provider_unverified', 'Exactly one full capture must be verified.');
      const captureId = captures[0].id;
      const capture = await this.#request('GET', `/v2/payments/captures/${captureId}`);
      if (!ok(capture)) fail('provider_unverified', 'Capture lookup did not verify the result.');
      verifyCapture(capture.body, record, captureId);
      return this.#ledger.complete(owner, operationId, captureId);
    } catch (error) { return this.#unknown(owner, operationId, error); }
  }
  captureOrder(owner, operationId) {
    return this.#run(owner, operationId, async () => {
      const record = this.#ledger.get(owner, operationId);
      if (record.merchantId !== this.#merchant) fail('merchant_changed', 'The pinned merchant cannot change.');
      if (record.state !== 'created') return this.#reconcile(owner, operationId); // No automatic re-POST, even after restart.
      this.#current(owner, record);
      const verified = await this.#reconcile(owner, operationId);
      if (verified.state !== 'created' || verified.providerOrderStatus !== 'APPROVED') return verified;
      this.#current(owner, verified); // An asynchronous GET may have raced with a scope edit.
      const intent = this.#ledger.startCapture(owner, operationId); // fsynced BEFORE POST.
      try {
        // The POST body need not contain full payee/amount evidence. Read it back
        // through fixed GET routes even after a successful minimal response.
        const response = await this.#request('POST', `/v2/checkout/orders/${intent.orderId}/capture`,
          { requestId: intent.captureRequestId, body: {} });
        if (!ok(response) || response.body?.id !== intent.orderId)
          fail('provider_unverified', 'Capture response is not sufficient proof.');
        return await this.#reconcile(owner, operationId);
      } catch (error) { return this.#unknown(owner, operationId, error); }
    });
  }
}
