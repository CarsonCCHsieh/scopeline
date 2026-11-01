import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { withSourceFacts, SOURCE_FACTS_VERSION } from '../src/ai/source-facts.mjs';
import { ScopeBook } from '../src/domain.mjs';
import { catalogConflicts } from '../src/catalog.mjs';

const empty = () => ({ requestedRequirements: [], missingQuestions: [] });
const values = draft => Object.fromEntries(draft.requestedRequirements.map(item => [item.field, item.value]));
const grounded = (raw, field, value) => ({ field, value, evidence: { start: 0, end: raw.length, quote: raw } });
const positives = [
  ['I need one English caption file.', 'captionsLanguage', 'English'],
  ['Could you prepare two Japanese subtitle files?', 'captionsLanguage', 'Japanese'],
  ['請做英文字幕檔案。', 'captionsLanguage', 'English'],
  ['英語の字幕ファイルを一つ作成してください。', 'captionsLanguage', 'English'],
  ['Please create highlight clips with Chinese subtitles.', 'captionsLanguage', 'Chinese'],
  ['I need English caption files. The source video is Japanese.', 'captionsLanguage', 'English'],
  ['I need caption files. Delivery starts after source receipt.', 'deliveryStarts', 'source_receipt'],
  ['I need caption files. Deliver 8 days after receipt of usable source material.', 'deliveryStarts', 'source_receipt'],
  ['請做字幕檔案。素材尚未準備好，交期是收妥可用素材後七天。不需要音樂，也不要代我發布。', 'deliveryStarts', 'source_receipt'],
  ['字幕ファイルを一つ作成してください。納期は素材受領後4日です。', 'deliveryStarts', 'source_receipt'],
  ['I need caption files. Delivery starts today.', 'deliveryStarts', 'calendar_now'],
  ['🎬\nI need English caption files. Delivery starts after source receipt.', 'captionsLanguage', 'English'],
];
const abstentions = [
  ['I need caption files. A client wrote: use English subtitles.', 'captionsLanguage'],
  ['I need English highlight clips.', 'captionsLanguage'],
  ['I need caption files. Previously English captions were requested; now Japanese is required.', 'captionsLanguage'],
  ['I need English caption files. The subtitles should be Japanese.', 'captionsLanguage'],
  ['I need English caption files. Now Klingon is required.', 'captionsLanguage'],
  ['I need English caption files. "Japanese subtitles"', 'captionsLanguage'],
  ['I need English caption files if my budget permits.', 'captionsLanguage'],
  ['Please create highlight clips with English captions with Japanese captions.', 'captionsLanguage'],
  ['請做英文字幕檔案。也需要日文字幕。', 'captionsLanguage'],
  ['I need caption files. Four days after source receipt was the old contract.', 'deliveryStarts'],
  ['I need caption files. Delivery does not start after source receipt.', 'deliveryStarts'],
  ['I need caption files. Seller says:\nDeliver four days after source receipt.', 'deliveryStarts'],
  ['I need caption files.\n> Delivery starts after source receipt.', 'deliveryStarts'],
  ['I need caption files. Delivery starts after source receipt. Delivery starts today.', 'deliveryStarts'],
  ['I need caption files. Delivery starts after source receipt. Delivery starts after source receipt.', 'deliveryStarts'],
  ['請製作英文字幕檔。交期從素材收齊後起算是上次的約定。', 'deliveryStarts'],
  ['英語の字幕ファイルをお願いします。納期起算は素材受領後ではありません。', 'deliveryStarts'],
  ['I need caption files. Delivery starts after source receipt unless approval is denied.', 'deliveryStarts'],
  ['Example:\nI need caption files. Delivery starts after source receipt.', 'deliveryStarts'],
  ['I need caption files. My source material is ready.', 'deliveryStarts'],
  ['I need caption files. Delivery starts today?', 'deliveryStarts'],
  ['請做字幕檔案。交期從今天起算？', 'deliveryStarts'],
  ['字幕ファイルを作成してください。納期は今日から起算します？', 'deliveryStarts'],
  ['I need English caption files. That was last year. This is only background context.', 'captionsLanguage'],
  ['I need English caption files. The previous sentence is only an example.', 'captionsLanguage'],
  ['請製作英文字幕檔。交期從素材收齊後起算是上次的約定。', 'captionsLanguage'],
  ['英語の字幕ファイルをお願いします。納期起算は素材受領後ではありません。', 'captionsLanguage'],
];

test('literal fact rules locate only explicit caption language and complete delivery anchors', async t => {
  for (const [brief, field, value] of positives) await t.test(brief, () => {
    const result = withSourceFacts(brief, empty());
    assert.equal(values(result.draft)[field], value);
    const evidence = result.draft.requestedRequirements.find(item => item.field === field).evidence;
    assert.equal(brief.slice(evidence.start, evidence.end), evidence.quote);
    assert.equal(brief.indexOf(evidence.quote), evidence.start);
    assert.equal(brief.indexOf(evidence.quote, evidence.start + 1), -1);
    assert.equal(result.sourceFacts.version, SOURCE_FACTS_VERSION);
    assert.equal(result.sourceFacts.fields[field].requiresHumanReview, true);
  });
});

test('indirect, changed, negated, conditional, quoted or competing facts suppress even a lexical model attribution', async t => {
  for (const [brief, field] of abstentions) await t.test(brief, () => {
    const result = withSourceFacts(brief, { requestedRequirements: [grounded(brief, field,
      field === 'captionsLanguage' ? 'English' : 'source_receipt')], missingQuestions: [] });
    assert.equal(values(result.draft)[field], undefined);
    assert.equal(result.sourceFacts.fields[field].status, 'manual_selection_required');
    assert.equal(result.sourceFacts.fields[field].modelValueSuppressed, true);
    assert.ok(result.draft.missingQuestions.length > 0 && result.draft.missingQuestions.length <= 5);
  });
});

test('an explicit caption request survives an unrelated, supported source-language statement', () => {
  const brief = 'I need English caption files. The source video is Japanese.';
  assert.equal(values(withSourceFacts(brief, empty()).draft).captionsLanguage, 'English');
});

test('model conflicts remain explained manual choices rather than silently overwritten values', () => {
  const brief = 'I need English caption files. Delivery starts after source receipt.';
  const result = withSourceFacts(brief, { requestedRequirements: [grounded(brief, 'captionsLanguage', 'Japanese'),
    grounded(brief, 'deliveryStarts', 'calendar_now')], missingQuestions: Array.from({ length: 5 }, (_, i) => `Question ${i}?`) });
  for (const field of ['captionsLanguage', 'deliveryStarts']) {
    assert.equal(values(result.draft)[field], undefined);
    assert.equal(result.sourceFacts.fields[field].modelConflict, true);
  }
  assert.equal(result.draft.missingQuestions.length, 5);
  assert.match(result.draft.missingQuestions[0], /disagree/);
  assert.match(result.draft.missingQuestions[1], /disagree/);
});

test('literal fact proposals cannot approve scope, hide catalog conflicts or create a quote', () => {
  const brief = 'I need Japanese caption files. Delivery starts today.';
  const result = withSourceFacts(brief, empty());
  const book = new ScopeBook(); const draft = book.createDraft('synthetic-owner', brief, result.draft);
  assert.ok(draft.catalogConflicts.some(item => item.id === 'captionsLanguage:unsupported_option'));
  assert.ok(draft.catalogConflicts.some(item => item.id === 'deliveryStarts:invalid_anchor'));
  assert.equal(draft.review, null); assert.equal(draft.quoteId, null);
  assert.throws(() => book.confirmQuote('synthetic-owner', draft.id, { expectedVersion: draft.version,
    reviewDigest: '', confirmScope: true, acceptCatalogPrice: true, expectedTotalCents: 3500 }));
  assert.throws(() => withSourceFacts(brief, { ...empty(), approved: true }));
  assert.throws(() => withSourceFacts(brief, { requestedRequirements: [{ field: 'deliveryStarts', value: 'source_receipt', evidence: { start: 0, end: 3, quote: 'fake' } }], missingQuestions: [] }));
});

test('four historical synthetic drafts project through the rules offline; no model evaluation is performed', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/literal-fact-projection.json', import.meta.url), 'utf8'));
  assert.equal(fixture.kind, 'historical_synthetic_drafts_for_offline_projection_only');
  for (const entry of fixture.cases) {
    const before = values(entry.observedDraft);
    const result = withSourceFacts(entry.brief, entry.observedDraft);
    const observed = values(result.draft);
    assert.deepEqual(observed, entry.expected, entry.id);
    assert.deepEqual(catalogConflicts(observed).map(item => item.id).sort(), [...entry.expectedConflicts].sort(), entry.id);
    for (const [field, value] of Object.entries(before)) {
      if (!['sku', 'captionsLanguage', 'deliveryStarts'].includes(field)) assert.equal(observed[field], value, `${entry.id}:${field}`);
    }
  }
});
