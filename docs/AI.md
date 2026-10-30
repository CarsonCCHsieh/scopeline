# Local draft extraction

This module connects a buyer brief to a local language model. It does not create a quote, authenticate a buyer, prove human consent, or call PayPal. The model's text is an unverified proposal even when every structural check passes.

## Data and control boundaries

`createLocalExtractor()` sends at most 2,000 UTF-16 code units of brief text and the three fictional service identifiers/names to `http://127.0.0.1:11434/api/chat`. It uses the existing `qwen3.5:9b` tag, a constrained response schema, no tools, `stream: false` and `think: false`. Prices, catalog limits, credentials and payment capabilities are not supplied by the application. A buyer could mention those strings in a brief; that does not grant authority.

The adapter accepts only the expected completed model response and a bounded JSON body. It performs one request at a time per extractor instance, with a 90-second deadline, a 64 KiB response cap, no redirects and no automatic retry. The current native HTTP server shares one extractor and additionally serializes AI operations across its anonymous workspaces, with request/session/body limits. The adapter does not expose Ollama to the network; the application listener is IPv4 loopback only. See [HTTP boundaries](HTTP.md).

Each model proposal includes an exact original-text quotation. Trusted code finds its unique occurrence and computes JavaScript UTF-16 offsets. Missing, ambiguous and overlapping repeated matches are rejected. Quotes are not translated, normalized or silently repaired. `validateAiDraft` then checks field types, bounds, duplicate fields and allowed keys. A quotation establishes where text occurred; it cannot establish that the model understood it correctly.

The suggested SKU is an unverified mapping from a service phrase, not an accepted purchase. Unknown or missing SKU means the offer has not been compared; an empty conflict array alone never means the draft fits an offer. The domain computes quantity, revision, language, format, timing, rights and publication conflicts using its own catalog. Missing fields stay unresolved independently of the model's follow-up questions.

## From extraction to a quote

Pass `result.draft` to `ScopeBook.createDraft(owner, originalBrief, result.draft)`. Keep the original brief unchanged. Present the proposals, source quotations, deterministic missing fields, comparison status and conflicts for review. Every correction and original conflict needs an explicit review record. Only a complete reviewed scope can produce a fixed catalog price.

`ScopeBook` is an in-memory domain component. The HTTP controller supplies ownership from its anonymous server-side session and enforces Origin/Host/CSRF checks. The three-language workbench presents explicit review and separate quote controls; model output cannot supply their confirmation flags. The [Sandbox payment service](PAYMENTS.md) is integrated separately and keeps durable operation records. Cookie possession and caller-supplied booleans do not prove identity, understanding or media rights. A successful model response never proves payment.

## Verification and model provenance

`npm test` runs non-inference tests. The adapter tests use fake HTTP responses for malformed or oversized content, timeouts, concurrency, field-type coercion, evidence ambiguity and forbidden price/approval fields. The server tests use actual loopback HTTP with injected fake extractors. Neither measures language-model quality or contacts PayPal.

`node tools/ai-probe.mjs` is an explicit separate local inference probe. It first reads the installed tag metadata and reported license, requires a local GGUF model, then runs owner-authored synthetic briefs sequentially. It creates a dated private receipt, records observed model/source hashes, preserves failed outcomes and checks for changes after the run. It never downloads a model or invokes PayPal. Do not run it on real account or payment data.

The historical first three-case run extracted English requested quantities and publication prohibitions, but omitted every suggested SKU and one Chinese source-readiness fact. Without a SKU, two offer-specific conflicts were not yet compared. This led to a prompt change distinguishing service-intent suggestions from accepted offers and requiring a field-by-field scan. These are observations of that earlier source/model snapshot.

The revised prompt was tested on those three briefs and a fourth synthetic caption-file brief. All four outcomes still had semantic gaps; this was not a passing quality evaluation.

| Synthetic brief | Observed gap after the prompt change |
| --- | --- |
| English clip request | SKU omitted; quantity and revision conflicts could not yet be compared. A follow-up asked about thumbnail style despite the clip request. |
| Chinese thumbnail request | SKU omitted. Source readiness was now extracted correctly, but the delivery-start condition was newly omitted. |
| Brief containing quoted malicious price/approval instructions | SKU omitted. The output did not contain price, approval or payment-success claims in this case. This one observation does not establish general injection resistance. |
| Caption-file request | SKU and the excess-revision conflict were correctly identified, but the explicit English caption language was omitted. The model asked again about language and asked about an aspect ratio that the offer does not use. |

Three of four revised-run drafts omitted the SKU. The current review workbench lists deterministic missing fields independently of model questions, allows manual completion and corrections, and compares the working scope after SKU selection. A completed extraction must not be advertised as a complete scope or an approved quote. These partial receipts remain unchanged; a later separate HTTP integration run does not replace them.

## One-shot HTTP integration evidence

On 2026-10-30, a separate end-to-end HTTP probe used one different, simpler cleared synthetic caption brief with the actual local adapter and model. It made exactly one `/api/chat` request, without retry or model download. The AI HTTP request completed in 18.833 seconds and returned all nine expected proposals, with no unexpected or mismatched proposal fields and valid exact UTF-16 quotation spans. `secondsPerDeliverable` and `aspectRatio` remained missing and required explicit manual `null` choices; the model returned two follow-up questions. The result remained `unverified_draft`, required human review and created no quote.

That historical run also passed 63 HTTP checks for the then-current public surface, session/CSRF boundaries and an explicitly selected manual scope-to-quote/Clear exercise. Review flags were caller assertions, not evidence of human understanding. The owned loopback server was closed afterward. `tools/flow-probe.mjs` prints a plan by default and requires `--run-once` for those operations. Public setup and verification do not require private development receipts.

One simpler synthetic success is not a representative model-quality pass, a regression rerun of the earlier four cases, evidence that their omissions are fixed, or a browser/UI/PayPal/deployment validation. Source changes after the recorded hashes need their own appropriate verification; do not attribute later race fixes to this run.

The tested installed tag reported GGUF/Q4_K_M and an Apache 2.0 license. This is an observation about that installed artifact, not a promise that a later mutable tag contains identical bytes. No weights are bundled. Use the linked model source/license, inspect your installed tag and validate its actual behavior. Model changes require a new provenance and quality check; clean judge-machine reproduction has not been performed.

Official references: [Ollama chat API](https://docs.ollama.com/api/chat), [structured outputs](https://docs.ollama.com/capabilities/structured-outputs), [model metadata API](https://github.com/ollama/ollama/blob/main/docs/api.md#show-model-information), [Ollama model listing](https://ollama.com/library/qwen3.5:9b), [Qwen model card](https://huggingface.co/Qwen/Qwen3.5-9B) and [upstream license](https://huggingface.co/Qwen/Qwen3.5-9B/blob/3770784d47152821ff8b46455b3abc794854235b/LICENSE).

Later coordinating verification exercised one actual AI request through desktop Chrome, followed by explicit review and a completed USD 35 Sandbox flow. The model returned nine proposals and left two scope fields for manual completion. English, Traditional Chinese and Japanese desktop views were checked separately. The full **126-case** offline suite does not run the model or PayPal. See [EVIDENCE.md](EVIDENCE.md) for the bounded public summary and [JUDGING.md](JUDGING.md) for free local setup.

Use only cleared synthetic briefs. No account/payment data, private runtime journal or credentials belong in model input or a public release. Real Sandbox execution and a successful simple extraction do not resolve the historical four-case omissions, establish representative multilingual extraction quality, or prove all mobile/accessibility states. Remote AI, clean-machine reproduction and production readiness are not claimed.
