import { createHash, randomUUID } from 'node:crypto';
import { CATALOG_VERSION, catalogConflicts, findSku, SYSTEM_RESTRICTIONS } from './catalog.mjs';
import { boundedText, fail, FIELDS, immutable, record, validateAiDraft, validateValue } from './contract.mjs';

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const ownerId = owner => boundedText(owner, 200, 'invalid_owner');
const fields = Object.keys(FIELDS);

function finalScope(input) {
  record(input, fields);
  const scope = {};
  for (const field of fields) { validateValue(field, input[field], { nullable: true }); scope[field] = input[field]; }
  const offer = findSku(scope.sku);
  if (offer && offer.maxSeconds !== null && scope.secondsPerDeliverable === null) fail('missing_field', 'This offer requires a clip duration.');
  const conflicts = catalogConflicts(scope);
  if (conflicts.length) fail('unresolved_conflict', 'The reviewed scope still conflicts with the catalog or system policy.');
  return immutable(scope);
}

function reviewDecisions(proposals, input, scope) {
  if (!Array.isArray(input) || input.length !== proposals.length) fail('review_incomplete', 'Review every model attribution explicitly.');
  const seen = new Set();
  const decisions = input.map(item => {
    record(item, ['field', 'decision', 'note']);
    const proposal = proposals.find(candidate => candidate.field === item.field);
    if (!proposal || seen.has(item.field)) fail('review_incomplete', 'Review decisions must match proposals exactly.');
    seen.add(item.field);
    if (!['accept', 'correct', 'not_requested'].includes(item.decision)) fail('invalid_decision', 'Unknown review decision.');
    if (item.decision === 'accept' && scope[item.field] !== proposal.value) fail('review_inconsistent', 'An accepted value cannot be silently changed.');
    if (typeof item.note !== 'string' || item.note.length > 300 || (item.decision !== 'accept' && !item.note.trim())) fail('invalid_decision', 'Corrections and false attributions need a bounded explanation.');
    return { field: item.field, decision: item.decision, note: item.note };
  });
  return immutable(decisions.sort((a, b) => a.field.localeCompare(b.field, 'en')));
}

function conflictResolutions(conflicts, input) {
  if (!Array.isArray(input) || input.length !== conflicts.length) fail('review_incomplete', 'Resolve every original deterministic conflict explicitly.');
  const seen = new Set();
  return immutable(input.map(item => {
    record(item, ['conflictId', 'action', 'note']);
    if (!conflicts.some(conflict => conflict.id === item.conflictId) || seen.has(item.conflictId)) fail('review_incomplete', 'Conflict resolutions must match exactly.');
    seen.add(item.conflictId);
    if (item.action !== 'accept_catalog_terms') fail('invalid_decision', 'Only accepting catalog terms can resolve these conflicts.');
    return { conflictId: item.conflictId, action: item.action, note: boundedText(item.note, 300) };
  }).sort((a, b) => a.conflictId.localeCompare(b.conflictId, 'en')));
}

/**
 * Synchronous, in-memory domain repository. Owner/confirmation values are assertions
 * from a future trusted controller, NOT authentication or proof a human clicked.
 * No persistence, HTTP, AI inference, payment operation or fulfillment lives here.
 */
export class ScopeBook {
  #drafts = new Map();
  #quotes = new Map();

  #owned(map, id, owner) {
    ownerId(owner);
    const entry = map.get(id);
    if (!entry || entry.owner !== owner) fail('not_found', 'The requested record is unavailable.');
    return entry;
  }

  createDraft(owner, rawBrief, aiDraft) {
    ownerId(owner);
    const extraction = validateAiDraft(rawBrief, aiDraft);
    const requested = Object.fromEntries(extraction.requestedRequirements.map(item => [item.field, item.value]));
    const view = immutable({ id: randomUUID(), version: 1, state: 'draft', rawBrief,
      briefDigest: digest(rawBrief), catalogVersion: CATALOG_VERSION,
      attributionStatus: 'unverified_model_proposals', ...extraction,
      catalogComparisonStatus: requested.sku === undefined ? 'sku_missing' : (findSku(requested.sku) ? 'compared' : 'sku_unsupported'),
      catalogConflicts: catalogConflicts(requested),
      missingFields: fields.filter(field => !Object.hasOwn(requested, field)),
      systemRestrictions: SYSTEM_RESTRICTIONS, review: null, quoteId: null });
    this.#drafts.set(view.id, { owner, view });
    return view;
  }

  getDraft(owner, draftId) { return this.#owned(this.#drafts, draftId, owner).view; }

  /** Explicit trusted-caller review boundary, not evidence of actual human consent. */
  reviewDraft(owner, draftId, input) {
    const entry = this.#owned(this.#drafts, draftId, owner);
    record(input, ['expectedVersion', 'scope', 'decisions', 'resolutions', 'confirmSourceGrounding', 'confirmRights']);
    if (input.expectedVersion !== entry.view.version) fail('stale_version', 'The draft changed; review its current version.');
    if (input.confirmSourceGrounding !== true || input.confirmRights !== true) fail('confirmation_required', 'Explicit grounding and rights confirmation assertions are required.');
    const scope = finalScope(input.scope);
    const decisions = reviewDecisions(entry.view.requestedRequirements, input.decisions, scope);
    const resolutions = conflictResolutions(entry.view.catalogConflicts, input.resolutions);
    const version = entry.view.version + 1;
    const reviewData = { scope, decisions, resolutions, version, briefDigest: entry.view.briefDigest, catalogVersion: CATALOG_VERSION,
      confirmationBoundary: 'trusted_caller_assertion_only', confirmSourceGrounding: true, confirmRights: true };
    const review = immutable({ ...reviewData, digest: digest(reviewData) });
    const view = immutable({ ...entry.view, version, state: 'reviewed', catalogComparisonStatus: 'compared', review, quoteId: null });
    this.#drafts.set(draftId, { owner, view });
    return view;
  }

  /** Compute exactly one catalog price for the current reviewed scope. */
  confirmQuote(owner, draftId, input) {
    const entry = this.#owned(this.#drafts, draftId, owner);
    record(input, ['expectedVersion', 'reviewDigest', 'confirmScope', 'acceptCatalogPrice', 'expectedTotalCents']);
    const draft = entry.view;
    if (input.expectedVersion !== draft.version) fail('stale_version', 'The draft changed; confirm its current version.');
    if (!draft.review || !['reviewed', 'confirmed_quote'].includes(draft.state)) fail('review_required', 'An explicitly reviewed scope is required before a quote.');
    if (input.reviewDigest !== draft.review.digest) fail('stale_review', 'The reviewed scope digest does not match.');
    if (input.confirmScope !== true || input.acceptCatalogPrice !== true) fail('confirmation_required', 'Explicit scope and catalog-price assertions are required.');
    // Revalidate the final scope. Never trust a model-supplied amount or currency.
    const scope = finalScope(draft.review.scope);
    const offer = findSku(scope.sku);
    if (!Number.isSafeInteger(input.expectedTotalCents) || input.expectedTotalCents !== offer.priceCents) fail('price_mismatch', 'The displayed catalog total must match exactly.');
    if (draft.quoteId) return this.getCurrentQuote(owner, draft.quoteId);
    const content = { id: randomUUID(), kind: 'confirmed_scope_quote', draftId, scopeVersion: draft.version,
      catalogVersion: CATALOG_VERSION, scope, reviewDigest: draft.review.digest,
      currency: offer.currency, totalCents: offer.priceCents,
      items: [{ sku: offer.sku, name: offer.name, quantity: 1, unitPriceCents: offer.priceCents, totalCents: offer.priceCents }],
      scopeAudit: { rawBrief: draft.rawBrief, requestedRequirements: draft.requestedRequirements,
        decisions: draft.review.decisions, resolutions: draft.review.resolutions },
      confirmationBoundary: 'trusted_caller_assertion_only', sandboxOnly: true, paymentStatus: 'not_started', createdAt: new Date().toISOString() };
    const quote = immutable({ ...content, digest: digest(content) });
    this.#quotes.set(quote.id, { owner, view: quote });
    this.#drafts.set(draftId, { owner, view: immutable({ ...draft, state: 'confirmed_quote', quoteId: quote.id }) });
    return quote;
  }

  /** Historical immutable quote; its existence does not mean paid or still current. */
  getQuote(owner, quoteId) { return this.#owned(this.#quotes, quoteId, owner).view; }

  /** Later order code must use this guard, then implement its own durable payment lifecycle. */
  getCurrentQuote(owner, quoteId) {
    const quote = this.getQuote(owner, quoteId);
    const draft = this.getDraft(owner, quote.draftId);
    if (draft.state !== 'confirmed_quote' || draft.quoteId !== quote.id || draft.version !== quote.scopeVersion
        || draft.review?.digest !== quote.reviewDigest) fail('stale_quote', 'This quote has been superseded by a scope review.');
    return quote;
  }
}
