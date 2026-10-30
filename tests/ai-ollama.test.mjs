import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalExtractor, wireToDraft, ENDPOINT, MODEL, MAX_BRIEF_CHARS } from '../src/ai/ollama.mjs';

const brief = '🎬 I need six clips, three revisions, and English captions. Do not publish.';
const wire = { requestedRequirements: [
  { field: 'deliverables', value: 6, quote: 'six clips' },
  { field: 'revisions', value: 3, quote: 'three revisions' },
  { field: 'publishRequested', value: false, quote: 'Do not publish.' },
], missingQuestions: ['When will usable source material arrive?'] };
const envelope = (content = JSON.stringify(wire), changes = {}) => ({
  model: MODEL, done: true, done_reason: 'stop', message: { role: 'assistant', content }, ...changes,
});
const response = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

test('exact unique quotations become UTF-16 spans, preserving requested values and negation', () => {
  const draft = wireToDraft(brief, wire);
  assert.equal(draft.requestedRequirements[0].value, 6);
  assert.equal(draft.requestedRequirements[1].value, 3);
  assert.equal(draft.requestedRequirements[2].value, false);
  for (const item of draft.requestedRequirements) assert.equal(brief.slice(item.evidence.start, item.evidence.end), item.evidence.quote);
  assert.equal(draft.requestedRequirements[0].evidence.start, brief.indexOf('six clips'));
  assert.ok(Object.isFrozen(draft.requestedRequirements));
});

test('missing, duplicate and overlapping quotations are rejected without guessed offsets', () => {
  for (const [text, quote] of [['Need six clips.', '6 clips'], ['six clips and six clips', 'six clips'], ['banana', 'ana']]) {
    assert.throws(() => wireToDraft(text, { requestedRequirements: [{ field: 'deliverables', value: 6, quote }], missingQuestions: [] }), { code: 'ungrounded_ai_draft' });
  }
});

test('price, approval, unknown fields and duplicate requirements cannot enter the domain', () => {
  for (const bad of [{ ...wire, priceCents: 1 }, { ...wire, approved: true },
    { ...wire, requestedRequirements: [{ field: 'priceCents', value: 1, quote: 'six clips' }] },
    { ...wire, requestedRequirements: [{ field: ['deliverables'], value: 6, quote: 'six clips' }, { field: ['deliverables'], value: 3, quote: 'three revisions' }] },
    { ...wire, requestedRequirements: [...wire.requestedRequirements, wire.requestedRequirements[0]] }]) {
    assert.throws(() => wireToDraft(brief, bad));
  }
});

test('request stays local, constrained and draft-only; it never receives a payment capability', async () => {
  let calls = 0;
  const extractor = createLocalExtractor({ fetchImpl: async (url, options) => {
    calls++; assert.equal(url, ENDPOINT); assert.equal(options.redirect, 'error');
    const sent = JSON.parse(options.body);
    assert.equal(sent.model, MODEL); assert.equal(sent.stream, false); assert.equal(sent.think, false);
    assert.equal(sent.messages[1].content, brief); assert.equal(sent.tools, undefined);
    assert.equal(sent.format.additionalProperties, false);
    assert.equal(JSON.stringify(sent).includes('priceCents'), false);
    return response(envelope());
  } });
  const result = await extractor.extractDraft(brief);
  assert.equal(calls, 1); assert.equal(result.metadata.status, 'unverified_draft');
  assert.equal(result.metadata.requiresHumanReview, true); assert.deepEqual(result.draft, wireToDraft(brief, wire));
});

test('truncated, wrong-model and tool-call responses never become drafts', async () => {
  for (const bad of [envelope(undefined, { done: false }), envelope(undefined, { done_reason: 'length' }),
    envelope(undefined, { model: 'another-model' }), envelope(undefined, { message: { role: 'assistant', content: JSON.stringify(wire), tool_calls: [{ name: 'pay' }] } })]) {
    await assert.rejects(createLocalExtractor({ fetchImpl: async () => response(bad) }).extractDraft(brief), { code: 'incomplete_ai_response' });
  }
});

test('invalid upstream data and oversized bodies return safe failures without leaking raw data', async () => {
  for (const make of [() => response(envelope('{secret upstream error')),
    () => new Response('secret upstream error', { status: 503 }),
    () => new Response('x'.repeat(65537), { headers: { 'Content-Type': 'application/json' } }),
    () => new Response('private HTML', { headers: { 'Content-Type': 'text/html' } })]) {
    let calls = 0;
    const extractor = createLocalExtractor({ fetchImpl: async () => { calls++; return make(); } });
    await assert.rejects(extractor.extractDraft(brief), error => error.name === 'DraftAiError' && !/secret|private HTML/.test(error.message));
    assert.equal(calls, 1);
  }
});

test('one extraction at a time; completion releases the slot', async () => {
  let resolveFirst;
  let calls = 0;
  const extractor = createLocalExtractor({ fetchImpl: () => {
    calls++; return calls === 1 ? new Promise(resolve => { resolveFirst = resolve; }) : Promise.resolve(response(envelope()));
  } });
  const pending = extractor.extractDraft(brief);
  await assert.rejects(extractor.extractDraft(brief), { code: 'ai_busy' });
  resolveFirst(response(envelope())); await pending;
  await extractor.extractDraft(brief); assert.equal(calls, 2);
});

test('timeout aborts the same request without retry and releases the slot', async () => {
  let calls = 0;
  const extractor = createLocalExtractor({ timeoutMs: 15, fetchImpl: async (_url, { signal }) => {
    calls++;
    if (calls > 1) return response(envelope());
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('private transport failure')), { once: true }));
  } });
  await assert.rejects(extractor.extractDraft(brief), { code: 'ai_timeout' });
  assert.equal(calls, 1); await extractor.extractDraft(brief); assert.equal(calls, 2);
});

test('input limits reject before inference', async () => {
  let calls = 0;
  const extractor = createLocalExtractor({ fetchImpl: async () => { calls++; return response(envelope()); } });
  for (const value of ['', ' ', 'x'.repeat(MAX_BRIEF_CHARS + 1), { text: brief }]) await assert.rejects(extractor.extractDraft(value));
  assert.equal(calls, 0);
});

test('early status, MIME and declared-size rejection abort transport before releasing its slot', async () => {
  for (const make of [() => new Response('not consumed', { status: 503 }),
    () => new Response('not consumed', { headers: { 'Content-Type': 'text/html' } }),
    () => new Response('not consumed', { headers: { 'Content-Type': 'application/json', 'Content-Length': '65537' } })]) {
    let requestSignal;
    const extractor = createLocalExtractor({ fetchImpl: async (_url, { signal }) => { requestSignal = signal; return make(); } });
    await assert.rejects(extractor.extractDraft(brief));
    assert.equal(requestSignal.aborted, true);
  }
});
