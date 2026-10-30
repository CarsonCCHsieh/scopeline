# PayPal Sandbox workflow and durable operation boundary

The native loopback controller connects a reviewed, fixed catalog quote to PayPal Sandbox order creation, browser approval and explicit capture. It is disabled unless the trusted launcher receives all four private sandbox settings. This is a fictional catalog demonstration with no live payment, subscription, webhook, refund or fulfillment. A return URL is not proof of approval or payment. Automated tests use fake providers; two actual Sandbox executions are separately recorded in [EVIDENCE.md](EVIDENCE.md). Complete free local setup is in [JUDGING.md](JUDGING.md).

## Run the sandbox workflow

Use Node 24 or newer. Use a sandbox REST application's credentials and the separate sandbox Business account's merchant/account ID. Keep the sandbox Personal buyer distinct from the seller. Save only these settings in the project's ignored `private.env`, replacing the placeholders with private Sandbox values:

```dotenv
SCOPELINE_PAYPAL_SANDBOX_ENABLED=1
PAYPAL_SANDBOX_CLIENT_ID=<sandbox REST client ID>
PAYPAL_SANDBOX_CLIENT_SECRET=<sandbox REST client secret>
PAYPAL_SANDBOX_MERCHANT_ID=<sandbox Business merchant ID>
```

Quote values according to Node's environment-file syntax when needed. Never paste credentials into source, terminal commands, screenshots, messages or test fixtures. There is no configurable PayPal API origin or live environment. The adapter hard-codes `https://api-m.sandbox.paypal.com`; browser approval uses `https://www.sandbox.paypal.com/checkoutnow?token=...` constructed from a verified order ID.

```sh
npm start
```

The launcher explicitly reads this project's `private.env` (regular file, at most 8 KiB); process environment values take precedence. `node --env-file=private.env tools/serve.mjs` is also supported. Setting `SCOPELINE_PAYPAL_SANDBOX_ENABLED=0`, or omitting the setting when no enabled private file exists, leaves payments disabled and opens no payment journal or OAuth connection. Do not expose this local server through a tunnel or proxy.

1. Keep the same server process and original workspace open. Enter a cleared synthetic brief, finish review, then confirm the fixed catalog quote. The browser cannot choose amount, currency, merchant or owner.
2. Explicitly create the Sandbox order. The server saves a durable intent before the first provider POST and locks the scope. Repeating the action returns the same operation, including an unknown result.
3. Open the supplied approval link in a separate tab and use the sandbox Personal buyer. The return/cancel page merely links back; it ignores query parameters and never captures anything.
4. Return to the original workspace and explicitly check/reconcile status. Request capture after the verified order is approved. Capture independently rechecks approval; it never trusts a browser assertion.
5. Only `payment.state: "completed"` represents verified completion. HTTP 200, a return URL, the domain quote or an order POST response alone does not. No fulfillment follows completion.

Private records are stored at `.private/paypal-ledger/`. Do not delete, move, edit or reset this directory to escape an unresolved operation. Pending/unknown operations block Clear. Completed operations allow Clear while preserving the journal.

## Controller and API contract

All mutations require the current anonymous session, exact loopback Origin, JSON and `X-CSRF-Token`. The controller derives ownership server-side. Cookie possession isolates a workspace; it is not buyer authentication or proof of human agreement.

| Route | Exact body | Result |
| --- | --- | --- |
| `GET /api/session` | none | `capabilities.paypal` reports whether the adapter was explicitly enabled; `payment` is null or the active draft's safe operation view. |
| `POST /api/payments/create` | `{quoteId}` | Current confirmed quote only. Reserve/create once or return its existing operation. |
| `POST /api/payments/:operationId/reconcile` | `{}` | Fixed provider GET verification only; never replay a create/capture POST. |
| `POST /api/payments/:operationId/capture` | `{}` | Verify approval, save capture intent, then dispatch capture at most once. Repeated calls can reconcile uncertain results but cannot repeat capture. |

Responses are `{payment: {id, quoteId, state, orderId, captureId, providerOrderStatus, lastIssue, sandboxOnly, locked, amount, approvalUrl}}`. Owner assertions, internal request IDs, credentials, payer details and raw provider diagnostics are excluded. `approvalUrl` exists only for verified `created` operations in `CREATED` or `PAYER_ACTION_REQUIRED`. A completed record has provider order status `COMPLETED` and a non-null verified capture ID. Domain quotes retain their original `paymentStatus: "not_started"`; the separate ledger supplies payment status.

`lastIssue` is null or `transport_unknown`, `provider_unverified`, `provider_pending`, `recovered_inflight`. Translate these safe enums rather than displaying raw errors. An uncertain provider operation normally returns HTTP 200 with state `unknown`, never a paid claim. Route failures include 503 `paypal_disabled`/`ledger_unavailable`, 409 `payment_busy`/`payment_locked`/`stale_quote`/`session_changed`, and indistinguishable 404 for unknown or foreign operation IDs. Extra browser-supplied price, currency, owner, order ID, return URL and success fields are rejected.

An existing operation locks review, quote and replacement drafts, even after completion. Read-only review preview remains available. Clear is permitted after completion and rotates the session; it never deletes payment records. Inert GET `/paypal/return` and `/paypal/cancel` pages accept cross-site navigation without reading or changing a session. Other routes retain cross-site rejection.

## Journal and service contract

`OrderLedger.open(privateDirectory)` acquires an exclusive writer lock and reads a bounded snapshot. Records retain an opaque owner, quote/draft/version/digests, catalog amount/currency, merchant, provider IDs and distinct stable UUIDs for create and capture. They exclude source briefs, payer data, raw responses and credentials. The launcher uses a stable private directory outside the static surface.

Each intent is written and fsynced before a provider POST is permitted. Snapshots are atomically renamed; on supported platforms the directory is also fsynced. Windows power-loss durability is not promised. A write uncertainty poisons that instance: stop operations and establish the persisted state before reopening it. The journal is not encrypted or tamper-proof. A crash can leave `.writer.lock`; an operator must establish that no writer remains before removing it. Locks and corrupt journals are never automatically discarded.

States are `creating`, `created`, `capture_pending`, `completed` and `unknown`. Reopening interrupted `creating`/`capture_pending` records converts them to `unknown`. Stable request IDs and the capture-started fence survive. There is no Clear/delete/reset method. Unknown create without an order ID requires manual operator reconciliation; no GET-by-request-ID flow is invented. There is no automatic recovery UI for that case.

`PaymentService({ledger,book,merchantId,transport,checkoutOrigin})` exposes `createOrder(owner,quoteId)`, `captureOrder(owner,operationId)` and `reconcile(owner,operationId)`. It pins the current quote, merchant, operation reference/invoice and quote custom ID. Capture checks the current quote before and after asynchronous approval lookup. An already dispatched request belongs to its pinned original quote.

A successful POST is insufficient completion evidence. Separate order GET and capture GET must agree on order/capture identity, merchant, exact full amount/currency, quote/reference/invoice linkage, final capture and completed status. Missing, pending or mismatched evidence remains unknown. Fixed GET reconciliation never follows provider response links or resubmits an uncertain capture.

## Transport and recovery limits

`createPayPalSandboxTransport({clientId,clientSecret})` is the real authenticated adapter. It accepts only the four needed Sandbox order/capture routes, constrained methods and headers. OAuth uses client credentials against the fixed Sandbox token endpoint. Credentials and access tokens remain server-side; token caching is in memory, capped at five minutes with an expiry margin. Concurrent callers can share one refresh without sharing payment operations.

Each call has a fixed 20-second overall deadline, including OAuth waiting, and a 128 KiB streamed UTF-8 JSON response bound. Redirects, live/foreign/normalized URLs, unexpected response URLs and malformed responses fail closed. Neither resource requests nor OAuth are automatically retried. A 401 clears the token for a later explicit operation without replaying the current request. Errors exclude raw provider bodies and secrets.

Session expiry (45 minutes idle/eight hours total) and restart remove in-memory books and anonymous ownership. The journal survives, but a new session cannot reclaim an old operation. Do not restart during approval as a retry strategy. If expiry, crash or unknown create occurs, retain the journal and investigate Sandbox seller transaction/order evidence before any replacement operation. There is no account recovery, cancellation endpoint or automatic unlock. A fresh cookie is not proof the earlier provider action failed. Resolve these limitations before any deployed or real-money service.

Protocol sources: official [OAuth authentication](https://developer.paypal.com/api/rest/authentication/), [Orders v2 API](https://developer.paypal.com/api/orders/v2/), [capture lookup API](https://developer.paypal.com/api/payments/v2/captures-get/) and [idempotency guidance](https://developer.paypal.com/api/rest/reference/idempotency/). Provider request-ID retention is finite; a stable UUID does not justify indefinite retries.

## Verification

The backend integration run on 2026-10-30 passed **115/115** offline cases: the historical 84 plus 9 integrated payment HTTP, 18 fake-fetch Sandbox adapter and 4 private-configuration cases. It covers fixed prices/hosts, ownership, CSRF, callback non-authority, mutation locks, durable intent, duplicate/unknown/restart behavior, write failures, evidence matching, token refresh/expiry, streaming bounds, abort/deadline and secret-safe failures. No actual OAuth, PayPal, model or browser request ran in that suite.

The later historical coordinating run passed **121/121**, adding six controlled payment-UI cases. The latest full offline run passed **126/126**. These suites use fake provider responses; they are not actual Sandbox transactions or browser acceptance.

The earlier 37-case payment-library/84-case combined runs cover an older library-only snapshot. Later real execution completed a USD 45 manual/API flow and a USD 35 AI/desktop-UI flow, with explicit capture and independent order/capture completion checks. Initial local Chrome navigation was blocked by the client, but a normal PayPal return-page link subsequently opened the actual workspace; the later UI flow ran there. See the public [evidence summary](EVIDENCE.md), which requires no private receipts. No broad mobile, accessibility, representative model-quality, production or deployment claim follows from these bounded checks.
