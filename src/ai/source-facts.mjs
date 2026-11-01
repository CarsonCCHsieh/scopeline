import { immutable, validateAiDraft } from '../contract.mjs';
import { withCatalogIntent } from './catalog-intent.mjs';

export const SOURCE_FACTS_VERSION = 'literal-scope-facts-2026-11-01-v1';
const fields = ['captionsLanguage', 'deliveryStarts'];
const number = String.raw`(?:[1-9][0-9]?|100|one|two|three|four|five|six|seven|eight|nine|ten|[一二三四五六七八九十兩百]+)`;
const source = String.raw`(?:usable\s+)?source(?:\s+(?:material|files?|video|footage))?`;
const receipt = String.raw`(?:${source}\s+receipt|receipt\s+of\s+(?:the\s+)?${source})`;
const sourceTiming = new RegExp(String.raw`^(?:deliver\s+(?:within\s+)?${number}\s+days?\s+after\s+${receipt}|delivery\s+(?:(?:should|must)\s+)?(?:takes?\s+${number}\s+days?\s+after\s+${receipt}|(?:is\s+)?${number}\s+days?\s+after\s+${receipt}|starts?\s+after\s+${receipt})|交期(?:是|為)?(?:收到|收妥|收齊)(?:可用)?素材後${number}天|交期從(?:收到|收妥|收齊)(?:可用)?素材後起算|納期は素材受領後${number}日(?:です)?|納期は素材受領後から起算します)$`, 'iu');
const nowTiming = /^(?:delivery\s+starts?\s+(?:today|now)|交期從(?:今天|現在)起算|納期は今日から起算します)$/iu;

// These classes establish only a narrow surrounding source frame. They do not
// extract, confirm or default their values. Unknown text invalidates the timing
// frame instead of being treated as another statement by the same speaker.
const contextStatements = [
  new RegExp(String.raw`^(?:(?:I|we)\s+(?:need|request|want)\s+${number}\s+revisions?|修改${number}次|修正${number}回(?:です)?)$`, 'iu'),
  /^(?:(?:the|my|our)\s+source(?:\s+(?:video|material|files?|footage))?\s+(?:is|are)\s+(?:not\s+)?ready|素材(?:尚未準備好|還沒準備好|已準備好|未就緒|已就緒)|素材(?:は|が)(?:準備できています|準備できていません|未準備です))$/iu,
  /^(?:no\s+music(?:\s+is\s+needed)?|(?:use|include)\s+(?:a\s+)?(?:song|music)\s+(?:for\s+which\s+I\s+have\s+no\s+license|without\s+a\s+license)|music\s+rights:\s*(?:none|licensed|unlicensed)|不需要音樂|無需音樂|不使用音樂|有音樂授權|沒有音樂授權|音楽は(?:不要です|必要ありません|許諾済みです))$/iu,
  /^(?:do\s+not\s+publish(?:\s+anything)?|no\s+publication|(?:也)?不要(?:代我)?發布|請勿發布|公開しないでください)$/iu,
];
const languageName = String.raw`(?:English|Traditional\s+Chinese|Chinese|Japanese|英文|繁體中文|中文|日文|英語|中国語|日本語)`;
const sourceLanguage = new RegExp(String.raw`^(?:(?:the|my|our)\s+source(?:\s+(?:video|material|files?|footage))?\s+(?:is|are)\s+${languageName}|素材語言是(?:英文|繁體中文|中文|日文)|素材は(?:英語|中国語|日本語)です)$`, 'iu');
const captionReference = new RegExp(String.raw`\b(?:captions?|subtitles?)\b|字幕|\b(?:English|Chinese|Japanese)\b|英文|中文|日文|英語|中国語|日本語|\b(?:now|instead|change[ds]?)\b|改成|改為|今は`, 'iu');
const languageTokens = new RegExp(String.raw`\b(?:Traditional\s+Chinese|English|Chinese|Japanese)\b|繁體中文|英文|中文|日文|英語|中国語|日本語`, 'giu');
const captionLanguage = /\b(Traditional\s+Chinese|English|Chinese|Japanese)\s+(?:captions?|subtitles?)(?:\s+files?)?\b|(繁體中文|英文|中文|日文)字幕(?:檔(?:案)?)?|(英語|中国語|日本語)の?字幕ファイル/giu;
const languages = { english: 'English', chinese: 'Chinese', japanese: 'Japanese', 'traditional chinese': 'Traditional Chinese',
  英文: 'English', 中文: 'Chinese', 日文: 'Japanese', 繁體中文: 'Traditional Chinese', 英語: 'English', 中国語: 'Chinese', 日本語: 'Japanese' };

function proposal(raw, field, value, start, end) {
  const quote = raw.slice(start, end);
  if (raw.indexOf(quote) !== start || raw.indexOf(quote, start + 1) !== -1) return null;
  return { field, value, evidence: { start, end, quote } };
}
function candidates(raw, prepared) {
  const manual = reason => ({ status: 'manual_selection_required', reason, proposal: null });
  const result = Object.fromEntries(fields.map(field => [field, manual('no_explicit_supported_source')]));
  if (prepared.serviceIntent.status !== 'suggested') return result;
  const request = prepared.draft.requestedRequirements.find(item => item.field === 'sku').evidence;
  // This small profile does not infer ownership across quoted/code material.
  // Apostrophes/contractions and otherwise unrelated quotes also abstain.
  if (/["'“”‘’「」『』`~]|^[\t ]*>/mu.test(raw)) {
    return Object.fromEntries(fields.map(field => [field, manual('quoted_source')]));
  }
  const remainder = raw.slice(request.end);
  const segments = [...remainder.matchAll(/[^.!?。！？;；,，\r\n]+/gu)].map(match => {
    const leading = match[0].length - match[0].trimStart().length;
    const end = request.end + match.index + match[0].trimEnd().length;
    return { text: match[0].trim(), start: request.end + match.index + leading, end,
      interrogative: /^\s*[?？]/u.test(raw.slice(end)) };
  }).filter(item => item.text);
  const completeFrame = segments.every(item => !item.interrogative && (sourceTiming.test(item.text) || nowTiming.test(item.text)
    || sourceLanguage.test(item.text) || contextStatements.some(pattern => pattern.test(item.text))));

  const languageMatches = [...request.quote.matchAll(captionLanguage)];
  const languageCount = [...request.quote.matchAll(languageTokens)].length;
  const changedLanguage = segments.some(item => !sourceLanguage.test(item.text) && captionReference.test(item.text));
  if (completeFrame && languageMatches.length === 1 && languageCount === 1 && !changedLanguage) {
    const match = languageMatches[0];
    const value = languages[(match[1] || match[2] || match[3]).replace(/\s+/gu, ' ').toLowerCase()];
    const found = proposal(raw, 'captionsLanguage', value, request.start, request.end);
    if (found) result.captionsLanguage = { status: 'suggested', reason: 'direct_caption_language', proposal: found };
  } else if (languageMatches.length > 1 || languageCount > 1 || changedLanguage) result.captionsLanguage = manual('multiple_or_changed_language');
  else if (!completeFrame) result.captionsLanguage = manual('unsupported_source_frame');

  const timing = segments.filter(item => !item.interrogative && (sourceTiming.test(item.text) || nowTiming.test(item.text)));
  if (completeFrame && timing.length === 1) {
    const item = timing[0], value = sourceTiming.test(item.text) ? 'source_receipt' : 'calendar_now';
    const found = proposal(raw, 'deliveryStarts', value, item.start, item.end);
    if (found) result.deliveryStarts = { status: 'suggested', reason: 'explicit_delivery_anchor', proposal: found };
  } else if (timing.length > 1) result.deliveryStarts = manual('multiple_delivery_candidates');
  else if (!completeFrame) result.deliveryStarts = manual('unsupported_source_frame');
  return result;
}

const guidance = {
  en: { captionsLanguage: 'Choose the caption language (or not applicable) in Scope review; the source rule could not confirm one clear value.', deliveryStarts: 'Choose when delivery starts in Scope review; the source rule could not confirm one clear anchor.' },
  zh: { captionsLanguage: '請在範圍審查選擇字幕語言或不適用；來源規則無法確認單一明確語言。', deliveryStarts: '請在範圍審查選擇交期起算點；來源規則無法確認單一明確起算點。' },
  ja: { captionsLanguage: '範囲レビューで字幕言語または対象外を選択してください。原文から一つの明確な言語を確認できません。', deliveryStarts: '範囲レビューで納期の起算点を選択してください。原文から一つの明確な起算点を確認できません。' },
};
const conflictLead = { en: 'Model and source rule disagree. ', zh: '模型與來源規則不一致。', ja: 'モデルと原文の規則が一致しません。' };
export function withSourceFacts(rawBrief, draft) {
  const prepared = withCatalogIntent(rawBrief, draft);
  const found = candidates(rawBrief, prepared);
  const requestedRequirements = prepared.draft.requestedRequirements.filter(item => !fields.includes(item.field));
  const questions = [];
  const locale = /^\s*(?:please|I|we|could)\b/iu.test(rawBrief) ? 'en' : /[ぁ-んァ-ヶ]/u.test(rawBrief) ? 'ja' : /\p{Script=Han}/u.test(rawBrief) ? 'zh' : 'en';
  const metadata = {};
  for (const field of fields) {
    const model = prepared.draft.requestedRequirements.find(item => item.field === field);
    let intent = found[field];
    const conflict = Boolean(model && intent.proposal && model.value !== intent.proposal.value);
    if (conflict) intent = { status: 'manual_selection_required', reason: 'model_conflict', proposal: null };
    if (intent.proposal) requestedRequirements.push(intent.proposal);
    else questions.push((conflict ? conflictLead[locale] : '') + guidance[locale][field]);
    metadata[field] = { status: intent.status, reason: intent.reason, requiresHumanReview: true,
      modelValueSuppressed: Boolean(model && !intent.proposal), modelConflict: conflict };
  }
  const prior = prepared.draft.missingQuestions;
  const missingQuestions = prepared.serviceIntent.status === 'manual_selection_required'
    ? [prior[0], ...questions, ...prior.slice(1)] : [...questions, ...prior];
  const checked = validateAiDraft(rawBrief, { requestedRequirements, missingQuestions: missingQuestions.slice(0, 5) });
  return immutable({ draft: checked, serviceIntent: prepared.serviceIntent,
    sourceFacts: { source: 'literal_scope_rules', version: SOURCE_FACTS_VERSION, fields: metadata, requiresHumanReview: true } });
}
