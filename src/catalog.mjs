import { immutable } from './contract.mjs';

// Fictional, owner-authored demonstration offers. No retailer or fulfillment claim.
export const CATALOG_VERSION = 'demo-2026-10-30-v1';
export const CATALOG = immutable([
  { sku: 'clip_pack', name: 'Three short highlights', currency: 'USD', priceCents: 9000,
    unitLabel: 'clip', maxDeliverables: 3, maxSeconds: 30, captionsLanguage: 'English', aspectRatio: '9:16', maxRevisions: 1, minDeliveryDays: 5 },
  { sku: 'thumbnail_pack', name: 'Three thumbnail concepts', currency: 'USD', priceCents: 4500,
    unitLabel: 'thumbnail', maxDeliverables: 3, maxSeconds: null, captionsLanguage: null, aspectRatio: '16:9', maxRevisions: 1, minDeliveryDays: 3 },
  { sku: 'caption_pack', name: 'One English caption file', currency: 'USD', priceCents: 3500,
    unitLabel: 'caption file', maxDeliverables: 1, maxSeconds: null, captionsLanguage: 'English', aspectRatio: null, maxRevisions: 1, minDeliveryDays: 3 },
]);
export const SYSTEM_RESTRICTIONS = immutable([
  { code: 'catalog_price_only', text: 'Only the fixed catalog sets prices; no budget-based or model prices.' },
  { code: 'no_publication', text: 'This demonstration does not publish, purchase media rights or send messages.' },
  { code: 'rights_required', text: 'Source and music rights need human confirmation; a draft cannot verify a license.' },
  { code: 'source_receipt_anchor', text: 'Delivery days start after usable source material is received, not before.' },
  { code: 'sandbox_only', text: 'Local PayPal Sandbox payments require explicit private setup. No real money or fulfillment.' },
]);
export const findSku = sku => CATALOG.find(item => item.sku === sku);

/** Catalog contradictions, never model-supplied and never attributed as new buyer requests. */
export function catalogConflicts(scope) {
  const conflicts = [];
  const add = (field, code, message) => conflicts.push({ id: `${field}:${code}`, field, code, message, source: 'catalog_or_system_policy' });
  const offer = findSku(scope.sku);
  if (scope.sku !== undefined && !offer) add('sku', 'unsupported_sku', 'The proposed service is not in this catalog.');
  if (offer) {
    for (const [field, maximum] of [['deliverables', offer.maxDeliverables], ['revisions', offer.maxRevisions]]) {
      if (scope[field] !== undefined && scope[field] > maximum) add(field, 'above_catalog_limit', `The offer includes at most ${maximum} ${field}.`);
    }
    if (scope.deliveryDays !== undefined && scope.deliveryDays < offer.minDeliveryDays) add('deliveryDays', 'too_soon', `Allow at least ${offer.minDeliveryDays} days after source receipt.`);
    if (scope.secondsPerDeliverable !== undefined && scope.secondsPerDeliverable !== null
        && (offer.maxSeconds === null || scope.secondsPerDeliverable > offer.maxSeconds)) add('secondsPerDeliverable', 'unsupported_duration', 'The requested duration is outside this offer.');
    for (const field of ['captionsLanguage', 'aspectRatio']) {
      if (scope[field] !== undefined && scope[field] !== offer[field]) add(field, 'unsupported_option', 'The requested option is outside this offer.');
    }
  }
  if (scope.deliveryStarts !== undefined && scope.deliveryStarts !== 'source_receipt') add('deliveryStarts', 'invalid_anchor', 'Delivery starts only after usable source receipt.');
  if (scope.musicRights !== undefined && !['none', 'licensed'].includes(scope.musicRights)) add('musicRights', 'rights_unconfirmed', 'Unlicensed or unknown music cannot be included.');
  if (scope.publishRequested === true) add('publishRequested', 'publication_unsupported', 'Publishing is outside this demonstration.');
  return immutable(conflicts);
}
