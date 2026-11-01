import { CATALOG, CATALOG_VERSION } from '../catalog.mjs';
import { boundedText, immutable, validateAiDraft } from '../contract.mjs';

export const CATALOG_INTENT_VERSION = 'catalog-alias-2026-11-01-v2';

// Deliberately finite service names, not a general-language understanding claim.
// Bare "clips", "captions", and "files" are ambiguous and are not aliases.
const ALIASES = [
  ['clip_pack', String.raw`\b(?:highlight\s+(?:clips?|videos?)|short\s+highlights?|clip_pack)\b|精華(?:短片|影片|片段)|ハイライト(?:動画|クリップ)`],
  ['thumbnail_pack', String.raw`\b(?:thumbnails?(?:\s+(?:images?|concepts?))?|thumbnail_pack)\b|(?:直播)?縮圖|サムネイル(?:画像)?`],
  ['caption_pack', String.raw`\b(?:(?:caption|subtitle)\s+files?|caption_pack)\b|字幕檔(?:案)?|字幕ファイル`],
];
const knownSkus = new Set(CATALOG.map(offer => offer.sku));
const enRequest = /^(?:please\s+(?:make|create|prepare|produce|deliver|design)|(?:I|we)\s+(?:need|request|want|would\s+like)|could\s+you\s+(?:make|create|prepare|produce|deliver|design)|(?:I|we)\s+choose)\b/iu;
const zhRequest = /^(?:請(?:幫我)?|麻煩(?:你)?|我(?:們)?(?:需要|想要|要|希望|想請你)|可以(?:請|幫我))/u;
const jaRequest = /(?:作ってください|作成してください|制作してください|用意してください|お願いします|を希望します|を依頼します|が必要です|が欲しいです)\s*$/u;
const conditional = /\b(?:if|unless|provided|assuming|depending|maybe|might|perhaps|possibly|consider(?:ing)?|whether|undecided|only\s+when|subject\s+to|pending\s+approval|contingent\s+on)\b|\bwhen\s+(?:I|we)\s+(?:approve|confirm|decide)\b|如果|若|假如|假設|除非|只要|可能|也許|考慮|再決定|是否|(?:等|待).{0,12}(?:核准|批准|同意|確定|預算)|(?:核准|批准|同意)(?:之後|後|才)|もし|なら|たら|場合|かもしれ|できれば|検討|承認(?:後|次第)/iu;
const uncertain = /\b(?:either|or|instead|without|except|excluding|avoid|not|no|never|don['’]t|do\s+not|didn['’]t|won['’]t|other\s+than|rather\s+than|apart\s+from)\b|不要|不需要|不是|不想|不用|無需|別(?:做|製作)|不(?:做|製作|打算)|或|還是|請問|想了解|代わりに|または|それとも|あるいは|いらない|要らない|必要ない|必要ありません|しない|ではなく|じゃなく|ません/iu;
const withdrawn = /\b(?:cancel|withdraw|disregard|retract|scratch|forget|never\s+mind|no\s+longer|changed\s+my\s+mind)\b|撤回|取消|算了|不用了|キャンセル|取り消|撤回|やめ/iu;

// A deliberately narrow direct-object grammar. An alias mentioned as a phrase,
// a source material, or inside an arbitrary larger sentence is not a request.
// Only explicit quantities/languages and a few scope-fact tails are admitted;
// everything else stays available through manual review instead of guesswork.
const enQuantity = String.raw`(?:an?|the|some|several|one|two|three|four|five|six|seven|eight|nine|ten|[0-9]+(?:[- ]second)?|[一二三四五六七八九十兩]+(?:張|支|段|個)?|English|Chinese|Japanese|Traditional\s+Chinese)`;
const enModifiers = new RegExp(String.raw`^(?:${enQuantity}\s*)*$`, 'iu');
const enFactTail = new RegExp(String.raw`^(?:\s*(?:in\s+[0-9]+:[0-9]+|with\s+(?:English|Chinese|Japanese|Traditional\s+Chinese)\s+(?:captions?|subtitles?)|(?:and|with|,)\s+(?:[0-9]+|one|two|three|four|five|six|seven|eight|nine|ten)\s+revisions?))*\s*$`, 'iu');
const zhModifiers = /^(?:(?:剪|製作|做|設計|準備|產出|提供)\s*)?(?:(?:[0-9]+|[一二三四五六七八九十兩百千]+)(?:張|支|段|個)?\s*)?(?:(?:英文|中文|日文)\s*)?$/u;
const zhFactTail = /^(?:\s*[，,]?\s*(?:修改(?:[0-9]+|[一二三四五六七八九十兩]+)次|比例\s*[0-9]+:[0-9]+|(?:加|含|附)(?:英文|中文|日文)字幕))*\s*$/u;
const jaModifiers = /^(?:(?:英語|中国語|日本語)の)?(?:(?:[0-9]+|[一二三四五六七八九十]+)(?:つ|本|枚|個)の)?$/u;
const jaObjectTail = /^(?:を|が)?(?:(?:[0-9]+|[一二三四五六七八九十]+)(?:つ|本|枚|個)?)?\s*$/u;
function directRequest(clause, aliasStart, aliasEnd) {
  const leading = clause.length - clause.trimStart().length;
  clause = clause.trimStart(); aliasStart -= leading; aliasEnd -= leading;
  const prefix = clause.slice(0, aliasStart), tail = clause.slice(aliasEnd);
  const en = enRequest.exec(clause);
  if (en && enModifiers.test(prefix.slice(en[0].length).trim()) && enFactTail.test(tail)) return true;
  const zh = zhRequest.exec(clause);
  if (zh && zhModifiers.test(prefix.slice(zh[0].length).trim()) && zhFactTail.test(tail)) return true;
  const ja = jaRequest.exec(clause);
  return Boolean(ja && ja.index >= aliasEnd && jaModifiers.test(prefix.trim()) && jaObjectTail.test(clause.slice(aliasEnd, ja.index).trim()));
}

function hasOtherNegativeCommand(text) {
  // The demonstrated publication prohibition is a separate scope fact. Other
  // negative actions can revoke or suspend the request, including across lines.
  for (const match of text.matchAll(/(?:^|[.!?。！？;；\r\n])\s*(?:please\s+)?(?:do\s+not|don't|don’t|never)\s+([^.!?。！？;；\r\n]+)/giu)) {
    if (!/^publish(?:\s+anything)?\s*$/iu.test(match[1])) return true;
  }
  return false;
}

// Mask quoted/code/example regions without changing UTF-16 positions. An
// unmatched delimiter fails closed; quotation location is not buyer intent.
function unquotedText(raw) {
  const chars = raw.split('');
  const closing = { '"': '"', "'": "'", '“': '”', '‘': '’', '「': '」', '『': '』', '`': '`' };
  let end = null;
  for (let i = 0; i < raw.length; i++) {
    if (end === '```' || end === '~~~') {
      if (raw.startsWith(end, i)) { chars.splice(i, 3, ' ', ' ', ' '); i += 2; end = null; }
      else chars[i] = ' ';
      continue;
    }
    const apostrophe = /['’]/u.test(raw[i]) && /[\p{L}\p{N}]/u.test(raw[i - 1] || '') && /[\p{L}\p{N}]/u.test(raw[i + 1] || '');
    if (end) {
      chars[i] = ' ';
      if (raw[i] === end && !apostrophe) end = null;
    } else if (raw.startsWith('```', i) || raw.startsWith('~~~', i)) {
      end = raw.slice(i, i + 3); chars.splice(i, 3, ' ', ' ', ' '); i += 2;
    } else if (closing[raw[i]] && !apostrophe) {
      end = closing[raw[i]]; chars[i] = ' ';
    }
  }
  let masked = chars.join('');
  masked = masked.replace(/^[\t ]*>[^\r\n]*/gmu, match => ' '.repeat(match.length));
  return { text: masked, unclosed: end !== null };
}

function locale(raw) {
  if (/^\s*(?:please|I|we|could)\b/iu.test(raw)) return 'en';
  return /[ぁ-んァ-ヶ]/u.test(raw) ? 'ja' : /\p{Script=Han}/u.test(raw) ? 'zh-TW' : 'en';
}
const GUIDANCE = {
  en: {
    no_clear_request: 'Choose the service in Scope review; there is no single clear supported service request.',
    quoted_text: 'Choose the service in Scope review; quoted or unfinished quoted text cannot establish your request.',
    uncertain_request: 'Choose the service in Scope review; its wording is negated, conditional, or uncertain.',
    multiple_services: 'Choose one service in Scope review; the brief mentions multiple services or alternatives.',
    unknown_service: 'Choose a supported service in Scope review; the brief includes an unknown service ID.',
    repeated_request: 'Choose the service in Scope review; repeated wording has no unique source quotation.',
    model_conflict: 'Choose the service in Scope review; the model suggestion conflicts with the request wording.',
    indirect_reference: 'Choose the service in Scope review; an example, another speaker, or source material does not establish your service request.',
    withdrawn_request: 'Choose the service in Scope review; the brief includes a cancellation or withdrawal.',
  },
  'zh-TW': {
    no_clear_request: '請在範圍審查手動選擇服務；目前沒有單一、明確且受支援的服務請求。',
    quoted_text: '請在範圍審查手動選擇服務；引用文字或未結束的引號無法確認你的服務請求。',
    uncertain_request: '請在範圍審查手動選擇服務；服務敘述含否定、條件或不確定語氣。',
    multiple_services: '請在範圍審查選擇一項服務；需求提到了多種服務或替代選項。',
    unknown_service: '請在範圍審查選擇受支援的服務；需求包含未知的服務代碼。',
    repeated_request: '請在範圍審查手動選擇服務；重複敘述無法定位到唯一原文引文。',
    model_conflict: '請在範圍審查手動選擇服務；模型建議與需求中的服務敘述不一致。',
    indirect_reference: '請在範圍審查手動選擇服務；範例、他人發言或素材用途無法確認你的服務請求。',
    withdrawn_request: '請在範圍審查手動選擇服務；需求包含取消或撤回的敘述。',
  },
  ja: {
    no_clear_request: '範囲レビューでサービスを選択してください。対応する明確な依頼を一つに特定できません。',
    quoted_text: '範囲レビューでサービスを選択してください。引用文や閉じていない引用符から依頼を確定できません。',
    uncertain_request: '範囲レビューでサービスを選択してください。否定、条件、不確かな表現が含まれています。',
    multiple_services: '範囲レビューで一つのサービスを選択してください。複数のサービスや代替案が含まれています。',
    unknown_service: '範囲レビューで対応サービスを選択してください。不明なサービスIDが含まれています。',
    repeated_request: '範囲レビューでサービスを選択してください。重複する文から引用箇所を一意に特定できません。',
    model_conflict: '範囲レビューでサービスを選択してください。モデルの提案と依頼文が一致しません。',
    indirect_reference: '範囲レビューでサービスを選択してください。例、他の話者、素材の用途から依頼を確定できません。',
    withdrawn_request: '範囲レビューでサービスを選択してください。キャンセルや撤回の表現が含まれています。',
  },
};

export function findCatalogIntent(rawBrief) {
  boundedText(rawBrief, 2000, 'invalid_brief');
  const manual = reason => immutable({ status: 'manual_selection_required', reason, proposal: null });
  if (ALIASES.length !== knownSkus.size || ALIASES.some(([sku]) => !knownSkus.has(sku))) return manual('unknown_service');
  const masked = unquotedText(rawBrief);
  if (masked.unclosed) return manual('quoted_text');
  // A leading condition in another sentence can still govern the request. This
  // intentionally also abstains on some clear services with unrelated conditions.
  if (conditional.test(masked.text)) return manual('uncertain_request');
  if (withdrawn.test(masked.text)) return manual('withdrawn_request');
  if (hasOtherNegativeCommand(masked.text)) return manual('uncertain_request');
  const literalIds = [...masked.text.matchAll(/\b[a-z][a-z0-9]*_pack\b/giu)].map(match => match[0].toLowerCase());
  const namedIds = [...masked.text.matchAll(/\bsku\s*[:=]\s*([a-z][a-z0-9_-]*)\b/giu)].map(match => match[1].toLowerCase());
  if ([...literalIds, ...namedIds].some(id => !knownSkus.has(id))) return manual('unknown_service');
  const mentions = [];
  for (const [sku, expression] of ALIASES) {
    for (const match of masked.text.matchAll(new RegExp(expression, 'giu'))) mentions.push({ sku, index: match.index, end: match.index + match[0].length });
  }
  if (!mentions.length) return manual(masked.text === rawBrief ? 'no_clear_request' : 'quoted_text');
  if (new Set(mentions.map(match => match.sku)).size !== 1) return manual('multiple_services');
  const clauses = [...masked.text.matchAll(/[^.!?。！？;；\r\n]+/gu)];
  let selected = null;
  for (const mention of mentions) {
    const clause = clauses.find(match => mention.index >= match.index && mention.index < match.index + match[0].length);
    if (!clause) return manual('no_clear_request');
    // A preceding textual paragraph can identify this as an attached message,
    // example or another speaker. No unrecognized source context is inferred.
    if (/[\p{L}\p{N}]/u.test(masked.text.slice(0, clause.index))) return manual('indirect_reference');
    const text = clause[0].trim();
    if (clause[0] !== rawBrief.slice(clause.index, clause.index + clause[0].length)) return manual('quoted_text');
    if (uncertain.test(text)) return manual('uncertain_request');
    // A language switch is supported; request grammar and service name need not
    // come from the same language. Narrative mentions deliberately abstain.
    if (!directRequest(clause[0], mention.index - clause.index, mention.end - clause.index)) return manual('no_clear_request');
    const leading = clause[0].length - clause[0].trimStart().length;
    const trailing = clause[0].trimEnd().length;
    const start = clause.index + leading, end = clause.index + trailing;
    const quote = rawBrief.slice(start, end);
    if (rawBrief.indexOf(quote) !== start || rawBrief.indexOf(quote, start + 1) !== -1) return manual('repeated_request');
    if (!selected) selected = { field: 'sku', value: mention.sku, evidence: { start, end, quote } };
  }
  return immutable({ status: 'suggested', reason: 'explicit_catalog_alias', proposal: selected });
}

export function withCatalogIntent(rawBrief, draft) {
  const checked = validateAiDraft(rawBrief, draft);
  let intent = findCatalogIntent(rawBrief);
  const modelSku = checked.requestedRequirements.find(item => item.field === 'sku');
  const conflict = Boolean(modelSku && intent.proposal && modelSku.value !== intent.proposal.value);
  if (conflict) intent = { status: 'manual_selection_required', reason: 'model_conflict', proposal: null };
  const requestedRequirements = checked.requestedRequirements.filter(item => item.field !== 'sku');
  if (intent.proposal) requestedRequirements.unshift(intent.proposal);
  const missingQuestions = intent.proposal ? checked.missingQuestions : [GUIDANCE[locale(rawBrief)][intent.reason], ...checked.missingQuestions].slice(0, 5);
  const result = validateAiDraft(rawBrief, { requestedRequirements, missingQuestions });
  return immutable({ draft: result, serviceIntent: {
    source: 'catalog_alias_rules', version: CATALOG_INTENT_VERSION, catalogVersion: CATALOG_VERSION,
    status: intent.status, reason: intent.reason, requiresHumanReview: true,
    modelSkuSuppressed: Boolean(modelSku && !intent.proposal), modelConflict: conflict,
  } });
}
