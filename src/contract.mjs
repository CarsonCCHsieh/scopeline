/** Strict untrusted extraction contract. Offsets are JavaScript UTF-16 code units. */
export class DomainError extends Error {
  constructor(code, message) { super(message); this.name = 'DomainError'; this.code = code; }
}

export function fail(code, message) { throw new DomainError(code, message); }
export function immutable(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
export function record(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('invalid_shape', 'Expected a plain record.');
  if (Object.keys(value).some(key => !allowed.includes(key))) fail('unknown_field', 'Unexpected fields are not accepted.');
  if (required.some(key => !Object.hasOwn(value, key))) fail('missing_field', 'Required fields are missing.');
}
export function boundedText(value, max, code = 'invalid_text') {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(code, 'Expected nonempty bounded text.');
  return value;
}

export const FIELDS = immutable({
  sku: 'string', deliverables: 'integer', secondsPerDeliverable: 'integer',
  captionsLanguage: 'string', aspectRatio: 'string', revisions: 'integer',
  deliveryDays: 'integer', deliveryStarts: 'string', sourceReady: 'boolean',
  musicRights: 'string', publishRequested: 'boolean',
});

export function validateValue(field, value, { nullable = false } = {}) {
  if (typeof field !== 'string' || !Object.hasOwn(FIELDS, field)) fail('unknown_field', 'Unknown requirement field.');
  if (nullable && value === null && ['secondsPerDeliverable', 'captionsLanguage', 'aspectRatio'].includes(field)) return;
  const type = FIELDS[field];
  if (type === 'integer') {
    const maximum = field === 'secondsPerDeliverable' ? 3600 : 100;
    const minimum = field === 'revisions' ? 0 : 1;
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail('invalid_value', 'A requirement is outside its supported bounds.');
  } else if (typeof value !== type) fail('invalid_value', 'A requirement has an invalid type.');
  if (type === 'string') boundedText(value, 64, 'invalid_value');
  if (field === 'deliveryStarts' && !['source_receipt', 'calendar_now', 'unspecified'].includes(value)) fail('invalid_value', 'Unknown delivery anchor.');
  if (field === 'musicRights' && !['none', 'licensed', 'unlicensed', 'unknown'].includes(value)) fail('invalid_value', 'Unknown music-rights state.');
}

/** Structural schema only: field-specific semantics and exact spans are checked below. */
export const AI_DRAFT_SCHEMA = immutable({
  type: 'object', additionalProperties: false, required: ['requestedRequirements', 'missingQuestions'],
  properties: {
    requestedRequirements: {
      type: 'array', maxItems: Object.keys(FIELDS).length,
      items: {
        type: 'object', additionalProperties: false, required: ['field', 'value', 'evidence'],
        properties: {
          field: { type: 'string', enum: Object.keys(FIELDS) },
          value: { anyOf: [{ type: 'string', minLength: 1, maxLength: 64 }, { type: 'integer', minimum: 0, maximum: 3600 }, { type: 'boolean' }] },
          evidence: {
            type: 'object', additionalProperties: false, required: ['start', 'end', 'quote'],
            properties: {
              start: { type: 'integer', minimum: 0, maximum: 6000 },
              end: { type: 'integer', minimum: 1, maximum: 6000 },
              quote: { type: 'string', minLength: 1, maxLength: 6000 },
            },
          },
        },
      },
    },
    missingQuestions: { type: 'array', maxItems: 5, items: { type: 'string', minLength: 1, maxLength: 180 } },
  },
});

/**
 * @param {string} rawBrief Original text, never trimmed or normalized before span validation.
 * @param {unknown} payload Untrusted model draft, never a price or approval.
 * @returns {{requestedRequirements: Array<object>, missingQuestions: string[]}}
 * Exact evidence proves a substring exists, NOT that an attribution is true.
 */
export function validateAiDraft(rawBrief, payload) {
  boundedText(rawBrief, 6000, 'invalid_brief');
  record(payload, ['requestedRequirements', 'missingQuestions']);
  if (!Array.isArray(payload.requestedRequirements) || payload.requestedRequirements.length > Object.keys(FIELDS).length
      || !Array.isArray(payload.missingQuestions) || payload.missingQuestions.length > 5) fail('invalid_shape', 'Draft arrays exceed their limits.');
  const seen = new Set();
  const requestedRequirements = payload.requestedRequirements.map(item => {
    record(item, ['field', 'value', 'evidence']);
    if (typeof item.field !== 'string' || !Object.hasOwn(FIELDS, item.field)) fail('unknown_field', 'Unknown requirement field.');
    if (seen.has(item.field)) fail('duplicate_requirement', 'One proposal per field is required.');
    seen.add(item.field); validateValue(item.field, item.value);
    record(item.evidence, ['start', 'end', 'quote']);
    const { start, end, quote } = item.evidence;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > rawBrief.length
        || typeof quote !== 'string' || rawBrief.slice(start, end) !== quote) fail('ungrounded_evidence', 'A proposal must cite an exact original-text span.');
    return { field: item.field, value: item.value, evidence: { start, end, quote } };
  });
  const missingQuestions = payload.missingQuestions.map(question => boundedText(question, 180));
  return immutable({ requestedRequirements, missingQuestions });
}
