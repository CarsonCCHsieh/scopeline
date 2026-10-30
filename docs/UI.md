# Review workspace

The buildless English, Traditional Chinese and Japanese interface lives entirely in `public/`. The home page is the application; `help.html` is a separate guide. The native Node server serves it on IPv4 loopback. Local desktop Chrome checks now include the three interface languages and an actual AI-to-Sandbox workflow. Their scope is recorded in [EVIDENCE.md](EVIDENCE.md); this is not complete mobile, accessibility or every-state acceptance. Follow [JUDGING.md](JUDGING.md) to run the working build.

## Files and design

- `index.html`: source brief, human review and separately confirmed catalog quote.
- `styles.css`: warm paper, ink, orange review marks and system/serif fonts; responsive layouts and visible keyboard focus. No external font, CDN, image or animation dependency.
- `app.mjs`: session API client and safe DOM rendering.
- `workspace-state.mjs`: foreground-operation ownership, review-context matching and current-quote checks. Superseding a browser operation does not cancel inference.
- `payment-state.mjs`: conservative payment-response validation, action eligibility and strict Sandbox approval-URL validation.
- `i18n.mjs`: English, Traditional Chinese and Japanese interface copy. Original source text, model values, quotations, model questions and server conflict/error text are preserved rather than translated as evidence.
- `help.html`, `help.mjs`: translated workflow and boundaries.

Only the language preference is written to browser local storage. Briefs, drafts, decisions and quotes are not stored there by the interface. The UI does not promise durable storage or account authentication. The server's session cookie and current session-memory response define the workspace.

## Explicit workflow

1. Enter at most 2,000 UTF-16 code units, matching the current local extractor input limit. A clearly labeled fictional sample can be inserted by a button; insertion never sends it.
2. Choose **Suggest a draft locally** or **Start a manual draft**. No draft request runs on page load or sample selection. An AI error preserves the original text and does not start manual extraction. There is no automatic inference retry.
3. The draft locks the source text, preserving exact quotations and UTF-16 source selection. Clearing the session workspace is required to start a new draft in this interface.
4. Complete all eleven scope fields. The three nullable fields distinguish undecided, explicitly not applicable (`null`) and a specified value. Boolean choices distinguish undecided, `false` and `true`. Number values are sent as integers. Missing fields never silently become zero, false or null.
5. Review every original model attribution. Its original value and exact quotation remain visible. `accept` requires strict equality with the final field; `correct` and `not_requested` require a nonempty note of at most 300 characters. `not_requested` disputes the attribution, not the existence of the required final scope field.
6. Resolve every original deterministic conflict with its own explicit catalog-terms checkbox and nonempty note. Original conflicts remain the audit set; a newly calculated comparison does not replace them. Saved resolutions are restored as historical records.
7. Tick both source-grounding and rights confirmations, then save the review. The interface sends the exact domain review payload with current version. No owner/authentication assertion is supplied by the browser.
8. Separately inspect the saved scope and catalog total, tick both quote confirmations, then explicitly record the quote. The quote payload contains current version, review digest and integer expected total; no model-supplied currency or price is accepted.

Before a payment exists, local review-field, decision or resolution edits hide the displayed quote, clear separate scope/price confirmations and require another review save. Saving that review invalidates the previous active quote. Unsaved edits are not server updates and a reload can discard them. The immutable quote itself never proves payment. An explicitly enabled Sandbox workflow displays a separate payment panel with create, approval, status-check and capture actions; only independently verified ledger completion displays a completed test receipt. There is no real-money payment or fulfillment.

Creating a Sandbox operation locks scope, quote and replacement-draft controls. Pending or unknown operations also block Clear. A completed operation keeps its original scope locked but permits Clear to start a new workspace while retaining the journal. Approval opens only the fixed Sandbox checkout origin in a new tab without opener access. Returning to the application does not approve or capture automatically. Unknown results allow status reconciliation, never a replacement payment or automatic capture retry. The UI renders only fixed translations for safe issue enums, not raw provider errors.

The explicit catalog-fill shortcut copies only offer limits, applicable options and delivery anchor. It does not assert source readiness, music rights, publication choice, model decisions or rights confirmations. It can invalidate an `accept` decision that no longer equals the model proposal; the review remains blocked until corrected.

## Comparison and model limitations

The browser displays a working comparison derived from the server-supplied catalog, with final validation performed by the domain on review save. A missing or unsupported SKU is shown as not compared. Missing fields are listed independently of model questions. An empty conflict list is not a fit, purchase or approval. A completed field set with no detected conflict is still explicitly subject to human review and server validation.

Original comparison status is derived from the original SKU attribution, since the domain's top-level comparison status can change after review. After review, final scope values come from `draft.review.scope`; original proposals and quotations remain separate.

The UI warns that questions and proposals may be incomplete. It does not advertise passing AI quality: the actual partial-model observations remain documented in `AI.md`. Manual drafts have no model extraction and are labeled using the server's `extraction.mode`, including after a reload.

## HTTP contract

All requests are same-origin, `credentials: 'same-origin'`, cache-disabled and reject redirects. POST requests are JSON and include `X-CSRF-Token` from the current bootstrap. Tokens and cookies are never rendered, logged, downloaded or stored in local storage.

- `GET /api/session` restores catalog, restrictions, capabilities, current draft/quote, extraction metadata, activity and CSRF.
- `POST /api/drafts`: `{ rawBrief, mode: 'ai' | 'manual' }`.
- `POST /api/drafts/:id/review`: `{ expectedVersion, scope, decisions, resolutions, confirmSourceGrounding: true, confirmRights: true }`.
- `POST /api/drafts/:id/quote`: `{ expectedVersion, reviewDigest, confirmScope: true, acceptCatalogPrice: true, expectedTotalCents }`.
- `POST /api/payments/create`: `{ quoteId }`; only the current server-confirmed quote is eligible.
- `POST /api/payments/:id/reconcile` and `/capture`: `{}`; owned server operation only, with no browser amount, merchant, order ID or approval assertion.
- `POST /api/clear`: `{}`; adopts the actual returned bootstrap and new CSRF only after success.

The optional server review-preview route is not required by this UI version. Request failures use safe text nodes and preserve input. AI requests have a 100-second client deadline for the 90-second extractor; payment actions have a 45-second client deadline; ordinary requests use 20 seconds. A client timeout does not prove server work stopped or a provider action failed. There is no automatic mutation retry; use explicit status refresh/reconciliation after uncertainty.

`activity.aiBusy` and `activity.workspaceBusy` disable relevant actions and explain the state. Startup, AI/manual draft creation, review, quote, Clear and Refresh each own a foreground-operation token. Only the current operation can update its result, error or completion state. Clear may supersede a pending AI action; a late success, error or `finally` from that older action cannot replace the newer workspace or unlock another operation's controls. This is client state ownership, not an inference-cancellation mechanism.

**Refresh status** makes a read-only session request, never a new inference request. If session CSRF, catalog version, draft ID/version, brief digest and review digest still identify the same review context, it synchronizes returned draft/quote/extraction/activity metadata without rebuilding the editable review controls. Unsaved scope, notes and review assertions are preserved. Dirty edits and an uncertain session prevent a server quote from being displayed as the current confirmed quote. If the session/review context changed, the returned server workspace is adopted; unsubmitted source text can be retained locally for recovery. A changed quote target resets the separate quote confirmations.

Clear has an explicit confirmation dialog and is available during the interface's own pending AI request. It is blocked during other foreground operations, an uncertain session or an unresolved Sandbox operation. A confirmed Clear response adopts the empty workspace and new CSRF, removes old form/quote/payment nodes and resets the source. Completed payment records remain in the private journal. This is workspace cleanup, not secure erasure.

If Clear fails or its response is lost, the interface does not infer whether the server cleared anything. It makes one read-only session reconciliation request, without retrying Clear. An unchanged review context keeps the existing form DOM; a changed context adopts the actual returned workspace. If both requests fail, input is retained, the session is marked `needsSync`, mutations and current-quote claims are blocked, and the user must explicitly Refresh status before continuing. That recovery path is a status read, never another inference or automatic mutation retry.

Clear does not stop an existing Ollama call. The server's AI slot can remain occupied until inference completes or its 90-second deadline expires. Neither a client timeout nor Clear/reconciliation establishes model-memory or provider-record deletion, or removal of other sessions. The guide explains the server's declared 45-minute inactivity / eight-hour absolute session lifetime and process-memory loss on restart; these are server boundaries, not browser persistence or deletion guarantees.

## Output safety and validation limits

Dynamic source/model/server strings are inserted using `textContent`, text nodes, form values and fixed safe element creation. The interface has no HTML interpolation, `innerHTML`, `eval`, external URL construction from model text, inline scripts or inline styles. Draft IDs are URL-encoded into fixed API paths. A source-jump button only selects a range in the existing read-only source textarea.

Historical 2026-10-30 verification passed 63 actual HTTP checks against an earlier controller/public-file snapshot. It exercised sessions/CSRF, manual machine review-to-quote, fixed USD 45 pricing, quote invalidation and Clear. One actual Ollama request returned nine expected proposals while two fields needed manual completion. That probe did not run the browser application or call PayPal and is not evidence for later source changes.

The later 47-case historical suite added foreground-operation/Clear/Refresh checks using controlled DOM/fetch responses. Subsequent 84-, 115- and 121-case suites covered later library, transport, controller and payment-UI additions. These are dated intermediate scopes, not the latest test count.

The coordinating full offline suite now passed **126/126**, using controlled providers rather than actual PayPal. Separate real execution includes two completed Sandbox flows, one through desktop Chrome with one local AI call, plus desktop viewing in English, Traditional Chinese and Japanese. See [EVIDENCE.md](EVIDENCE.md) for the exact boundaries. Earlier semantic gaps remain; mobile, complete keyboard/accessibility coverage and all UI state combinations have not been established. No automated check proves human understanding or rights ownership.
