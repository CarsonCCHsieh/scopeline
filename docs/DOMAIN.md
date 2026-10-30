# Scope-to-quote domain contract

This document describes the local in-memory domain used by the native loopback HTTP server and three-language review workbench. The [HTTP contract](HTTP.md) and [UI behavior](UI.md) are documented separately. Domain or HTTP confirmation flags do not prove genuine human approval or payment.

## Untrusted extraction

`AI_DRAFT_SCHEMA` and `validateAiDraft(rawBrief, payload)` are exported by [`contract.mjs`](../src/contract.mjs). The domain accepts a nonempty original brief of at most 6,000 JavaScript UTF-16 code units; the current HTTP endpoint, UI and local AI adapter impose the tighter 2,000-code-unit limit. Text is not trimmed, translated or normalized before evidence validation.

```js
{
  requestedRequirements: [
    { field: 'deliverables', value: 6,
      evidence: { start: 7, end: 16, quote: 'six clips' } }
  ],
  missingQuestions: []
}
```

For this example, the unchanged brief could be `I need six clips`. Offsets are zero-based JavaScript UTF-16 indexes with an exclusive end. Every `evidence.quote` must equal `rawBrief.slice(start, end)` exactly. The domain accepts a specified matching occurrence; the local AI adapter additionally requires its selected quotation to be unique before constructing offsets. Substring existence is not semantic grounding: citing “Do not publish” for `publishRequested: true` passes a lexical span check but is a false attribution that still needs correction.

The only fields are `sku`, `deliverables`, `secondsPerDeliverable`, `captionsLanguage`, `aspectRatio`, `revisions`, `deliveryDays`, `deliveryStarts`, `sourceReady`, `musicRights` and `publishRequested`. There is at most one proposal per field. Omit unknown fields instead of guessing. Numbers must be bounded safe integers of the correct type, never numeric strings. `deliveryStarts` accepts `source_receipt`, `calendar_now` or `unspecified`; `musicRights` accepts `none`, `licensed`, `unlicensed` or `unknown`. Other string options are bounded and checked against the catalog later. There are at most five untrusted missing-question strings, each at most 180 code units.

The validator enforces this fixed contract directly; it is not a general JSON Schema engine. It rejects additional fields, prices, currency, model conflict lists and model approval flags. Its output is a frozen copy of the same draft contract and can be validated again. Neither missing questions nor model proposals are asserted facts. The current workbench renders raw/model text as plain data using safe DOM operations; this remains a requirement for other renderers.

## Catalog and conflict separation

The owner-authored fictional catalog is fixed in [`catalog.mjs`](../src/catalog.mjs), version `demo-2026-10-30-v1`. The exported catalog is deeply frozen. Quotes cannot supply a replacement catalog or custom price.

| SKU | Included maximum | Revisions | Earliest delivery after usable source receipt | Fixed USD cents |
| --- | --- | --- | --- | --- |
| `clip_pack` | Three clips, each up to 30 seconds, English captions, 9:16 | One | Five days | 9,000 |
| `thumbnail_pack` | Three thumbnail concepts, 16:9 | One | Three days | 4,500 |
| `caption_pack` | One English caption file | One | Three days | 3,500 |

Selecting fewer deliverables does not prorate the package price. Additional packs, rush work and extra revisions are unsupported. This is catalog policy, not a PayPal limit or an actual fulfillment promise.

A draft keeps three separate collections:

1. `requestedRequirements`: unverified model attributions with exact source spans.
2. `catalogConflicts`: deterministic comparisons, including a proposed unsupported SKU; no model-generated conflict list is accepted.
3. `systemRestrictions`: price, publication, rights, delivery-anchor and sandbox limits authored by the application. Their presence never means the buyer requested an unsafe action.

Missing fields are reported separately. `catalogComparisonStatus` is `sku_missing` if no offer is selected, `sku_unsupported` for an unsupported offer and `compared` after a known offer is compared. An empty conflict array without a SKU is pending comparison, not compliance. After a successful explicit review, the status is `compared` for the final scope; original proposal conflicts are retained with their review resolutions. The status alone never means approved or paid.

Delivery must start after usable source receipt even when `sourceReady` is false; the source-ready assertion is not evidence that a file exists. Unknown or unlicensed music blocks an agreed scope. Publishing is outside this demonstration. The current interface requires an explicit rights confirmation, but neither the interface nor this domain verifies licenses or proves who reviewed them.

## Domain calls

`ScopeBook` is exported by [`domain.mjs`](../src/domain.mjs). It has no network calls and no payment methods. Calls are synchronous; stored records are private Maps, and returned snapshots are deeply frozen. The current HTTP server derives owner values from server-side anonymous sessions and does not accept them from browser or model input. Direct library callers must enforce their own ownership boundary; an owner string alone is not account authentication.

| Call | Boundary |
| --- | --- |
| `createDraft(owner, rawBrief, aiDraft)` | Validate untrusted extraction; store original text, proposals, deterministic conflicts and missing fields as version 1. No price/quote/payment is created. |
| `getDraft(owner, draftId)` | Return the owner's frozen draft; absent and foreign identifiers both fail with `not_found`. This checks the supplied owner assertion, not an authenticated session. |
| `reviewDraft(owner, draftId, input)` | Require the current version, complete final scope, all attribution decisions, all original conflict resolutions and explicit grounding/rights assertions. Recompute conflicts and create a new review version/digest. |
| `confirmQuote(owner, draftId, input)` | Require the current reviewed version/digest, explicit scope/price assertions and an exact integer-cent displayed total matching the fixed catalog. Create or return that review's immutable quote. |
| `getQuote(owner, quoteId)` | Return a historical snapshot; this does not mean paid or still current. |
| `getCurrentQuote(owner, quoteId)` | Reject superseded scope/review/quote versions. This is only a domain guard, not a checkout or provider-readiness signal. |

`reviewDraft` accepts exactly:

```js
{
  expectedVersion,
  scope, // All eleven fields above, with explicit nulls only for inapplicable
         // secondsPerDeliverable, captionsLanguage or aspectRatio.
  decisions: [{ field, decision: 'accept', note: '' }],
  resolutions: [{ conflictId, action: 'accept_catalog_terms', note: '...' }],
  confirmSourceGrounding: true,
  confirmRights: true
}
```

Every original proposal needs one decision: `accept`, `correct` or `not_requested`. An accepted proposal must match the final value; corrections and false attributions require a nonempty explanation. Each original deterministic conflict needs exactly one explicit resolution, and the final scope must independently pass the catalog. A note cannot waive a limit. Manual entry after empty extraction is possible only through the same complete review boundary; it is not labelled AI extraction.

`confirmQuote` accepts exactly:

```js
{
  expectedVersion,
  reviewDigest,
  confirmScope: true,
  acceptCatalogPrice: true,
  expectedTotalCents // Must equal the selected catalog offer; no supplied currency.
}
```

These booleans are trusted-caller assertions that any caller can supply, not cryptographic human consent. Quotes explicitly record `confirmationBoundary: 'trusted_caller_assertion_only'`, `sandboxOnly: true` and `paymentStatus: 'not_started'`. The SHA-256 digest identifies content; it is not a signature or an authentication mechanism. Quote IDs are random UUIDs. A later review leaves historical quotes intact and requires a new confirmation. Original text and decisions remain attached to each quote's scope audit.

## Current integration and remaining gates

The local application now provides editable review controls, server-derived anonymous workspace owners, session isolation, Origin/Host/CSRF checks, plain-text rendering and bounded requests. Clear, 45-minute idle expiry, eight-hour absolute expiry and process termination remove accessible session records. These boundaries do not identify a real buyer, prove human approval, securely erase memory or delete local-model state.

A deployed real-money application would need authenticated identity and recovery, HTTPS and operational controls beyond this local demonstration. The implemented Sandbox workflow already uses a private single-writer journal, stable separate create/capture request IDs, operation serialization and exact amount/currency/merchant reconciliation. Do not infer payment success from a domain quote or browser callback.

The [payment workflow](PAYMENTS.md) connects this domain to the native HTTP controller and a real, opt-in Sandbox transport. An existing operation locks saved review, quote and replacement-draft mutations. In-flight or unresolved operations also block Clear; completed records remain in the private journal after Clear. The immutable quote retains `paymentStatus: 'not_started'`; only the separate payment record can establish independently verified Sandbox completion.

After creating a payment order, the service pins its quote/version/digests and checks the current quote before and after asynchronous approval lookup. It saves capture intent before dispatch. An unknown result never authorizes another capture POST. Session expiry or restart preserves the journal but loses the in-memory workspace owner; the prototype has no owner-recovery login.

The local AI adapter is separate from this core and can fail honestly. It never invokes `reviewDraft` or `confirmQuote`. A historical 2026-10-30 probe passed 63 actual HTTP checks and made one synthetic local extraction; it covered that earlier source snapshot and did not establish browser behavior or PayPal execution. Later verification includes two actual Sandbox flows and a 126-case offline suite; see the public [evidence summary](EVIDENCE.md). Neither caller assertions nor these machine checks prove a person's understanding or media rights. Earlier model omissions remain relevant; see [AI findings](AI.md).

Representative model evaluation, complete visual/accessibility coverage, clean judge-machine reproduction and remote deployment remain separate work. Desktop browser checks and two actual Sandbox completions have a bounded scope recorded in [EVIDENCE.md](EVIDENCE.md). Follow [JUDGING.md](JUDGING.md) for local setup; the anonymous session model is not a production security claim.
