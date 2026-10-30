// UI guards only. The server owns the quote, amount, payment lock and capture receipt.
const states = new Set(['creating', 'created', 'capture_pending', 'completed', 'unknown']);
const reference = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);

export function paymentAmountCents(payment) {
  const amount = payment?.amount;
  if (amount?.currency !== 'USD' || typeof amount.value !== 'string' || !/^\d{1,7}\.\d{2}$/.test(amount.value)) return null;
  const [whole, fraction] = amount.value.split('.');
  return Number(whole) * 100 + Number(fraction);
}

export function validPayment(payment) {
  if (!payment || !reference(payment.id) || !reference(payment.quoteId) || !states.has(payment.state) || payment.sandboxOnly !== true || paymentAmountCents(payment) === null) return false;
  if (payment.orderId !== null && payment.orderId !== undefined && !/^[A-Z0-9]{1,64}$/.test(payment.orderId)) return false;
  if (payment.state === 'completed' && (payment.providerOrderStatus !== 'COMPLETED' || !reference(payment.captureId))) return false;
  return true;
}

export function sandboxApprovalUrl(payment) {
  if (!validPayment(payment) || payment.state !== 'created' || !payment.orderId || typeof payment.approvalUrl !== 'string') return null;
  try {
    const url = new URL(payment.approvalUrl);
    if (url.protocol !== 'https:' || url.hostname !== 'www.sandbox.paypal.com' || url.port || url.username || url.password || url.pathname !== '/checkoutnow' || url.hash) return null;
    if ([...url.searchParams.keys()].length !== 1 || url.searchParams.get('token') !== payment.orderId) return null;
    return url.href;
  } catch { return null; }
}

export function canCapturePayment(payment, reconciledId) {
  return validPayment(payment) && payment.state === 'created' && payment.providerOrderStatus === 'APPROVED' && Boolean(payment.orderId) && reconciledId === payment.id;
}

export function paymentMatchesQuote(payment, quote) {
  return validPayment(payment) && Boolean(quote) && payment.quoteId === quote.id && quote.currency === 'USD' && paymentAmountCents(payment) === quote.totalCents;
}

export function paymentDisplayState({ payment = null, quote = null, uncertain = false, needsSync = false, inFlight = false } = {}) {
  if (uncertain || (payment && (needsSync || !paymentMatchesQuote(payment, quote) || payment.state === 'unknown'))) return 'unverified';
  if (payment?.state === 'completed') return 'verified';
  return payment || inFlight ? 'in_progress':'not_started';
}
