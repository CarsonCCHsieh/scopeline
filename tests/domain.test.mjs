import test from 'node:test';
import assert from 'node:assert/strict';
import { ScopeBook } from '../src/domain.mjs';
import { AI_DRAFT_SCHEMA, validateAiDraft } from '../src/contract.mjs';
import { CATALOG, findSku } from '../src/catalog.mjs';

const brief = 'For clip_pack: make 3 clips, each 30 seconds, English captions, 9:16, 1 revision, 5 days after source receipt. Source ready: yes. Music: none. Do not publish.';
function proposed(raw, values) {
  return { requestedRequirements: Object.entries(values).map(([field, [value, quote]]) => {
    const start = raw.indexOf(quote); assert.ok(start >= 0);
    return { field, value, evidence: { start, end: start + quote.length, quote } };
  }), missingQuestions: [] };
}
const aiDraft = () => proposed(brief, {
  sku: ['clip_pack', 'clip_pack'], deliverables: [3, '3 clips'], secondsPerDeliverable: [30, '30 seconds'],
  captionsLanguage: ['English', 'English captions'], aspectRatio: ['9:16', '9:16'], revisions: [1, '1 revision'],
  deliveryDays: [5, '5 days'], deliveryStarts: ['source_receipt', 'after source receipt'],
  sourceReady: [true, 'Source ready: yes'], musicRights: ['none', 'Music: none'], publishRequested: [false, 'Do not publish'],
});
const scope = (changes = {}) => ({ sku: 'clip_pack', deliverables: 3, secondsPerDeliverable: 30,
  captionsLanguage: 'English', aspectRatio: '9:16', revisions: 1, deliveryDays: 5,
  deliveryStarts: 'source_receipt', sourceReady: true, musicRights: 'none', publishRequested: false, ...changes });
function reviewInput(draft, final = scope()) {
  return { expectedVersion: draft.version, scope: final,
    decisions: draft.requestedRequirements.map(item => ({ field: item.field,
      decision: final[item.field] === item.value ? 'accept' : 'correct',
      note: final[item.field] === item.value ? '' : 'Explicitly accept the catalog alternative instead.' })),
    resolutions: draft.catalogConflicts.map(item => ({ conflictId: item.id, action: 'accept_catalog_terms', note: 'Reviewed this difference; accept the stated catalog terms.' })),
    confirmSourceGrounding: true, confirmRights: true };
}
const confirmation = (draft, amount = 9000) => ({ expectedVersion: draft.version, reviewDigest: draft.review?.digest,
  confirmScope: true, acceptCatalogPrice: true, expectedTotalCents: amount });
const error = (code, action) => assert.throws(action, e => e?.code === code);
function reviewed(book = new ScopeBook(), owner = 'session-a') {
  const draft = book.createDraft(owner, brief, aiDraft());
  return { book, draft: book.reviewDraft(owner, draft.id, reviewInput(draft)) };
}

test('A structurally valid AI draft cannot become a quote without an independent review call', () => {
  const book = new ScopeBook(); const draft = book.createDraft('a', brief, aiDraft());
  assert.equal(draft.state, 'draft'); assert.equal(draft.attributionStatus, 'unverified_model_proposals');
  assert.equal(draft.catalogComparisonStatus, 'compared');
  error('review_required', () => book.confirmQuote('a', draft.id, confirmation(draft)));
  assert.equal(book.getDraft('a', draft.id).state, 'draft');
});

test('Model prices, payment flags, invented request fields and model-supplied conflicts are rejected', () => {
  for (const extra of ['priceCents', 'currency', 'approved', 'catalogConflicts', 'systemRestrictions']) {
    error('unknown_field', () => validateAiDraft(brief, { ...aiDraft(), [extra]: extra === 'priceCents' ? 1 : 'untrusted' }));
  }
  const draft = aiDraft(); draft.requestedRequirements[0].priceCents = 1;
  error('unknown_field', () => validateAiDraft(brief, draft));
  const other = aiDraft(); other.requestedRequirements[0].field = 'budgetCents';
  error('unknown_field', () => validateAiDraft(brief, other));
  assert.equal(AI_DRAFT_SCHEMA.additionalProperties, false);
});

test('Exact UTF-16 evidence is required, including non-BMP text; offsets never normalize the original', () => {
  const raw = '🎬 繁中需求：3 clips';
  const valid = proposed(raw, { deliverables: [3, '3 clips'] });
  assert.equal(validateAiDraft(raw, valid).requestedRequirements[0].evidence.start, raw.indexOf('3 clips'));
  const wrong = structuredClone(valid); wrong.requestedRequirements[0].evidence.start--;
  error('ungrounded_evidence', () => validateAiDraft(raw, wrong));
  const fabricated = structuredClone(valid); fabricated.requestedRequirements[0].evidence.quote = 'six clips';
  error('ungrounded_evidence', () => validateAiDraft(raw, fabricated));
});

test('Non-string field aliases cannot bypass uniqueness and overwrite a conflicting requested count', () => {
  const raw = 'Six clips were requested, not three.';
  const start = raw.indexOf('Six clips');
  const evidence = { start, end: start + 'Six clips'.length, quote: 'Six clips' };
  const aliased = { requestedRequirements: [
    { field: ['deliverables'], value: 6, evidence },
    { field: ['deliverables'], value: 3, evidence },
  ], missingQuestions: [] };
  error('unknown_field', () => validateAiDraft(raw, aliased));
  error('unknown_field', () => new ScopeBook().createDraft('a', raw, aliased));
  for (const field of [null, 1, false, {}, new String('deliverables')]) {
    error('unknown_field', () => validateAiDraft(raw, { requestedRequirements: [{ field, value: 3, evidence }], missingQuestions: [] }));
  }
});

test('Duplicate fields, coercion, unbounded inputs and malformed evidence fail closed', () => {
  const duplicate = aiDraft(); duplicate.requestedRequirements.push(duplicate.requestedRequirements[0]);
  // Keep under the field-count cap so the duplicate check is exercised.
  duplicate.requestedRequirements.splice(1, 1);
  error('duplicate_requirement', () => validateAiDraft(brief, duplicate));
  const stringCount = aiDraft(); stringCount.requestedRequirements[1].value = '3';
  error('invalid_value', () => validateAiDraft(brief, stringCount));
  const negative = aiDraft(); negative.requestedRequirements[1].evidence.end = -1;
  error('ungrounded_evidence', () => validateAiDraft(brief, negative));
  error('invalid_brief', () => validateAiDraft('x'.repeat(6001), aiDraft()));
  error('invalid_shape', () => validateAiDraft(brief, { ...aiDraft(), missingQuestions: Array(6).fill('Question?') }));
});

test('The original probe quantity/revision/timing/music conflicts are calculated without model conflict claims', () => {
  const raw = 'I need six clips with three revisions in five days. The source is not uploaded yet. Use unlicensed music. Do not publish, purchase or send messages.';
  const extracted = proposed(raw, { sku: ['clip_pack', 'six clips'], deliverables: [6, 'six clips'], revisions: [3, 'three revisions'],
    deliveryDays: [5, 'five days'], deliveryStarts: ['calendar_now', 'in five days'],
    sourceReady: [false, 'not uploaded yet'], musicRights: ['unlicensed', 'unlicensed music'], publishRequested: [false, 'Do not publish'] });
  const book = new ScopeBook(); const draft = book.createDraft('a', raw, extracted);
  assert.deepEqual(draft.catalogConflicts.map(c => c.field).sort(), ['deliverables', 'deliveryStarts', 'musicRights', 'revisions'].sort());
  assert.equal(draft.requestedRequirements.length, 8);
  assert.equal(draft.systemRestrictions.some(item => item.code === 'catalog_price_only'), true);
  assert.equal(draft.requestedRequirements.some(item => item.field === 'pricePolicy'), false);
  const input = reviewInput(draft, scope({ sourceReady: false }));
  input.resolutions = [];
  error('review_incomplete', () => book.reviewDraft('a', draft.id, input));
  assert.equal(book.getDraft('a', draft.id).version, 1);
  const result = book.reviewDraft('a', draft.id, reviewInput(draft, scope({ sourceReady: false })));
  const quote = book.confirmQuote('a', result.id, confirmation(result));
  assert.equal(quote.totalCents, 9000); assert.equal(quote.scope.deliveryStarts, 'source_receipt');
  assert.equal(quote.scopeAudit.rawBrief, raw); assert.equal(quote.scopeAudit.resolutions.length, 4);
});

test('A quote cannot waive count, revisions, duration, language, format, timing, rights or publishing conflicts', () => {
  const changes = [ { deliverables: 6 }, { revisions: 3 }, { secondsPerDeliverable: 31 }, { captionsLanguage: 'Other' },
    { aspectRatio: '16:9' }, { deliveryDays: 1 }, { deliveryStarts: 'calendar_now' }, { musicRights: 'unknown' },
    { musicRights: 'unlicensed' }, { publishRequested: true }, { sku: 'unsupported' } ];
  for (const change of changes) {
    const book = new ScopeBook(); const draft = book.createDraft('a', brief, aiDraft());
    error('unresolved_conflict', () => book.reviewDraft('a', draft.id, reviewInput(draft, scope(change))));
    assert.equal(book.getDraft('a', draft.id).state, 'draft');
  }
});

test('A matching source span is not semantic proof: false publishing attribution needs explicit correction', () => {
  const bad = aiDraft(); bad.requestedRequirements.find(item => item.field === 'publishRequested').value = true;
  const book = new ScopeBook(); const draft = book.createDraft('a', brief, bad);
  assert.equal(draft.requestedRequirements.at(-1).evidence.quote, 'Do not publish');
  assert.equal(draft.attributionStatus, 'unverified_model_proposals');
  const input = reviewInput(draft); input.decisions.find(item => item.field === 'publishRequested').decision = 'not_requested';
  input.decisions.find(item => item.field === 'publishRequested').note = 'Buyer explicitly forbids publication; this is a model misattribution.';
  const result = book.reviewDraft('a', draft.id, input);
  const quote = book.confirmQuote('a', result.id, confirmation(result));
  assert.equal(quote.scope.publishRequested, false);
  assert.equal(quote.scopeAudit.decisions.find(item => item.field === 'publishRequested').decision, 'not_requested');
  assert.equal(quote.confirmationBoundary, 'trusted_caller_assertion_only');
});

test('Review requires all attributions, consistent accepts and explicit grounding/rights assertions', () => {
  const book = new ScopeBook(); const draft = book.createDraft('a', brief, aiDraft());
  for (const flag of ['confirmSourceGrounding', 'confirmRights']) {
    error('confirmation_required', () => book.reviewDraft('a', draft.id, { ...reviewInput(draft), [flag]: false }));
  }
  error('review_incomplete', () => book.reviewDraft('a', draft.id, { ...reviewInput(draft), decisions: [] }));
  const inconsistent = reviewInput(draft, scope({ revisions: 0 }));
  inconsistent.decisions.find(item => item.field === 'revisions').decision = 'accept';
  error('review_inconsistent', () => book.reviewDraft('a', draft.id, inconsistent));
  const noNote = reviewInput(draft, scope({ revisions: 0 })); noNote.decisions.find(item => item.field === 'revisions').note = '';
  error('invalid_decision', () => book.reviewDraft('a', draft.id, noNote));
});

test('Missing model fields stay missing; a complete explicitly reviewed scope can be entered manually', () => {
  const book = new ScopeBook(); const draft = book.createDraft('a', 'A fictional project, still unspecified.', { requestedRequirements: [], missingQuestions: ['Which service is intended?'] });
  assert.equal(draft.missingFields.length, 11); assert.equal(draft.requestedRequirements.length, 0);
  assert.equal(draft.catalogComparisonStatus, 'sku_missing');
  assert.equal(draft.catalogConflicts.length, 0); // No selected offer means not yet compared, not compliant.
  const unsupported = book.createDraft('a', 'Unsupported service.', proposed('Unsupported service.', { sku: ['unsupported', 'Unsupported'] }));
  assert.equal(unsupported.catalogComparisonStatus, 'sku_unsupported');
  error('missing_field', () => book.reviewDraft('a', draft.id, { ...reviewInput(draft), scope: { sku: 'clip_pack' } }));
  const result = book.reviewDraft('a', draft.id, reviewInput(draft));
  assert.equal(result.catalogComparisonStatus, 'compared');
  assert.equal(book.confirmQuote('a', result.id, confirmation(result)).totalCents, 9000);
});

test('Only fixed catalog cents and USD are used; fractional totals and extra currency/price fields are refused', () => {
  const { book, draft } = reviewed();
  for (const amount of [1, 8999, 9000.5, '9000', NaN, Infinity]) error('price_mismatch', () => book.confirmQuote('session-a', draft.id, confirmation(draft, amount)));
  error('unknown_field', () => book.confirmQuote('session-a', draft.id, { ...confirmation(draft), currency: 'TWD' }));
  const quote = book.confirmQuote('session-a', draft.id, confirmation(draft));
  assert.equal(quote.currency, 'USD'); assert.equal(quote.items[0].quantity, 1);
  assert.equal(quote.totalCents, quote.items[0].totalCents); assert.equal(quote.paymentStatus, 'not_started');
  assert.equal(quote.sandboxOnly, true);
});

test('Each of the three demonstration offers is priced only from its own catalog entry', () => {
  for (const [sku, amount] of [['clip_pack', 9000], ['thumbnail_pack', 4500], ['caption_pack', 3500]]) {
    const book = new ScopeBook(); const draft = book.createDraft('a', 'Manually choose a fictional offer.', { requestedRequirements: [], missingQuestions: [] });
    const offer = findSku(sku);
    const final = scope({ sku, deliverables: offer.maxDeliverables, secondsPerDeliverable: offer.maxSeconds,
      captionsLanguage: offer.captionsLanguage, aspectRatio: offer.aspectRatio, deliveryDays: offer.minDeliveryDays });
    const result = book.reviewDraft('a', draft.id, reviewInput(draft, final));
    assert.equal(book.confirmQuote('a', draft.id, confirmation(result, amount)).totalCents, amount);
  }
});

test('Stale versions/digests, missing confirmation flags and foreign-owner access fail', () => {
  const { book, draft } = reviewed();
  error('stale_version', () => book.reviewDraft('session-a', draft.id, { ...reviewInput(draft), expectedVersion: 1 }));
  error('stale_version', () => book.confirmQuote('session-a', draft.id, { ...confirmation(draft), expectedVersion: 1 }));
  error('stale_review', () => book.confirmQuote('session-a', draft.id, { ...confirmation(draft), reviewDigest: 'tampered' }));
  for (const flag of ['confirmScope', 'acceptCatalogPrice']) error('confirmation_required', () => book.confirmQuote('session-a', draft.id, { ...confirmation(draft), [flag]: false }));
  error('not_found', () => book.getDraft('other', draft.id));
  error('not_found', () => book.reviewDraft('other', draft.id, reviewInput(draft)));
  error('not_found', () => book.confirmQuote('other', draft.id, confirmation(draft)));
  const quote = book.confirmQuote('session-a', draft.id, confirmation(draft));
  error('not_found', () => book.getQuote('other', quote.id));
  error('not_found', () => book.getCurrentQuote('other', quote.id));
});

test('Reconfirming the same reviewed version returns one immutable quote; edits supersede rather than mutate it', () => {
  const { book, draft } = reviewed(); const quote = book.confirmQuote('session-a', draft.id, confirmation(draft));
  assert.strictEqual(book.confirmQuote('session-a', draft.id, confirmation(draft)), quote);
  const current = book.getDraft('session-a', draft.id);
  const edited = book.reviewDraft('session-a', draft.id, reviewInput(current, scope({ revisions: 0 })));
  error('stale_quote', () => book.getCurrentQuote('session-a', quote.id));
  error('stale_version', () => book.confirmQuote('session-a', draft.id, confirmation(draft)));
  const next = book.confirmQuote('session-a', draft.id, confirmation(edited));
  assert.notEqual(next.id, quote.id); assert.notEqual(next.digest, quote.digest);
  assert.equal(quote.scope.revisions, 1); assert.equal(next.scope.revisions, 0);
  assert.strictEqual(book.getQuote('session-a', quote.id), quote);
});

test('Input aliases and returned objects cannot mutate stored requests, reviews, quotes or catalog', () => {
  const book = new ScopeBook(); const model = aiDraft(); const draft = book.createDraft('a', brief, model);
  model.requestedRequirements[0].value = 'unsupported';
  assert.equal(draft.requestedRequirements[0].value, 'clip_pack');
  const input = reviewInput(draft); const result = book.reviewDraft('a', draft.id, input);
  input.scope.revisions = 99; input.decisions[0].note = 'changed later';
  const quote = book.confirmQuote('a', result.id, confirmation(result));
  assert.throws(() => { quote.scope.revisions = 99; }, TypeError);
  assert.throws(() => { quote.items[0].totalCents = 1; }, TypeError);
  assert.throws(() => { CATALOG[0].priceCents = 1; }, TypeError);
  assert.equal(book.getCurrentQuote('a', quote.id).totalCents, 9000);
  assert.match(quote.digest, /^[a-f0-9]{64}$/);
});
