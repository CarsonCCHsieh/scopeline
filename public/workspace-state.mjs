// Browser operation ownership only. Superseding a request does not cancel inference.
export function createOperationGate() {
  let epoch = 0, serial = 0, foreground = null;
  const current = op => foreground === op && op?.epoch === epoch;
  return {
    begin(kind, { supersede = false } = {}) {
      if (foreground && !supersede) throw new Error('An operation is already in progress.');
      if (supersede) epoch++;
      const op = Object.freeze({ id: ++serial, epoch, kind });
      foreground = op;
      return op;
    },
    current,
    finish(op) {
      if (!current(op)) return false;
      foreground = null;
      return true;
    },
    get busy() { return foreground !== null; },
    get kind() { return foreground?.kind ?? null; }
  };
}

export function sameReviewContext(previous, incoming) {
  if (!previous.ready || previous.csrf !== incoming.csrf || previous.catalogVersion !== incoming.catalogVersion) return false;
  const before = previous.draft, after = incoming.draft;
  if (!before || !after) return before === null && after === null;
  return before.id === after.id && before.version === after.version
    && before.briefDigest === after.briefDigest && before.review?.digest === after.review?.digest;
}

export function isCurrentQuote({ draft, quote, dirty = false, needsSync = false }) {
  return Boolean(!dirty && !needsSync && draft?.state === 'confirmed_quote' && quote
    && draft.quoteId === quote.id && quote.draftId === draft.id
    && quote.scopeVersion === draft.version && quote.reviewDigest === draft.review?.digest);
}

export function sameQuoteTarget(before, after) {
  return before.draft?.review?.digest === after.draft?.review?.digest
    && before.quote?.id === after.quote?.id
    && before.quote?.reviewDigest === after.quote?.reviewDigest
    && before.quote?.totalCents === after.quote?.totalCents
    && before.quote?.currency === after.quote?.currency;
}
