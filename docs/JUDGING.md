# Judge setup and working demo

SCOPELINE turns an untrusted brief extraction into an explicitly reviewed scope and a server-priced PayPal Sandbox order. The model cannot approve scope, choose prices or invoke payment. Run the complete build locally; no hosted AI service is assumed. The source uses native Node modules and is [MIT licensed](../LICENSE).

## Prerequisites

- Node.js **24 or newer**; the coordinating machine used **24.14.0**. Obtain Node from [nodejs.org](https://nodejs.org/en/download).
- For actual AI extraction: [Ollama](https://ollama.com/download) and the exact model tag **`qwen3.5:9b`**. This is a multi-gigabyte download that needs suitable local memory and disk; performance on arbitrary judge hardware has not been measured. No model weights are included here.
- For actual payment testing: a free PayPal Developer Sandbox account, a sandbox Business seller, a separate sandbox Personal buyer and a dedicated sandbox REST application. No live credentials, paid AI credits, real card or real-money purchase is part of this workflow.

Download/clone this repository and open its root in a terminal. There are no npm dependencies to install.

```sh
node --version
npm test
```

The coordinating full offline run passed 126 cases. Tests use fake model/provider responses and synthetic temporary files, not your credentials. Passing them is not a real Sandbox transaction. The two actual observed flows are summarized in [EVIDENCE.md](EVIDENCE.md).

## Start the local AI

Install and start Ollama. Its desktop application may already run the local service; otherwise run `ollama serve` in a separate terminal. Do not expose port 11434 publicly. Download the model explicitly:

```sh
ollama pull qwen3.5:9b
ollama list
ollama show qwen3.5:9b
```

The application calls only `http://127.0.0.1:11434/api/chat`, with `qwen3.5:9b`, structured output and a 90-second extraction deadline. A later mutable tag need not reproduce the original installed bytes. Inspect your model/license and review every result. See [AI behavior and known omissions](AI.md). There is no automatic model download, inference on page load, retry or silent manual fallback.

Without Ollama, you can deliberately choose the manual draft path and test the domain/payment flow. That is manual input, not AI inference. To assess the complete AI-plus-PayPal build, enable the actual local model as above.

## Enable your own free Sandbox

1. Sign in to the [PayPal Developer Dashboard](https://developer.paypal.com/dashboard/). Confirm **Sandbox**, not Live, in Apps & Credentials.
2. Under Sandbox accounts, use/create a **Business** seller and a distinct **Personal** buyer. These are test identities; do not enter a real buyer's personal or financial details into SCOPELINE.
3. Create/select a dedicated **Sandbox REST application** for that seller. Obtain its sandbox client ID and client secret privately. Obtain the Business seller's merchant/account ID from its Sandbox account profile. Do not use the application ID, client ID or buyer ID as the merchant ID.
4. In this repository root, manually create **`private.env`**. Replace all three placeholders below with your own Sandbox values. The placeholder text is not a working credential.

```dotenv
SCOPELINE_PAYPAL_SANDBOX_ENABLED=1
PAYPAL_SANDBOX_CLIENT_ID=REPLACE_WITH_SANDBOX_CLIENT_ID
PAYPAL_SANDBOX_CLIENT_SECRET=REPLACE_WITH_SANDBOX_CLIENT_SECRET
PAYPAL_SANDBOX_MERCHANT_ID=REPLACE_WITH_SANDBOX_BUSINESS_MERCHANT_ID
```

`private.env` and its variants are excluded by `.gitignore`. Keep it outside screenshots, Git, prompts and shared archives. Use Node environment-file quoting if a value requires it. No credentials, access tokens or buyer login are distributed in this repository. The coordinating owner-managed Sandbox path was exercised; a second developer's onboarding/account setup has **not** been separately tested. The [official Sandbox account guide](https://developer.paypal.com/tools/sandbox/accounts/) describes account creation.

```sh
npm start
```

Open **`http://127.0.0.1:31929/`**. Alternatively, `node --env-file=private.env tools/serve.mjs` loads the same settings; explicit process environment values take precedence. Leave this process and original workspace open throughout approval/capture. `SCOPELINE_PORT` can select an unoccupied port; use its exact `127.0.0.1` URL, not `localhost`. The launch log says whether Sandbox is enabled without printing credentials.

For a clean clone with no private settings, `npm start` leaves payments disabled. To explicitly disable an existing private configuration, set `SCOPELINE_PAYPAL_SANDBOX_ENABLED=0`. This is a local server, not a production deployment: do not expose it through a proxy/tunnel. Its Host, Origin, cookies and return URLs intentionally target loopback.

## AI, explicit review and USD 35 Sandbox walkthrough

Select English for these instructions; the interface also offers Traditional Chinese and Japanese. Paste this owner-authored fictional brief, or insert the application's clearly labeled sample and review its different requested terms:

> I need one English caption file, with one revision, delivered three days after usable source material is received. The source is ready. No music is included. Do not publish anything. This is a fictional demonstration.

Choose **Suggest a draft locally** once. A successful model response remains unverified. Check each quotation against the original; correct or mark false attributions with a note. The model can omit a SKU or other fields, and its questions may be incomplete. An extraction failure preserves the brief; retry only deliberately or explicitly choose a manual draft.

For this caption example, complete all eleven final fields:

| Field | Explicit final value |
| --- | --- |
| Offer | `caption_pack` — one English caption file |
| Deliverables | `1` |
| Seconds per deliverable | Not applicable (`null`) |
| Caption language | `English` |
| Aspect ratio | Not applicable (`null`) |
| Revisions | `1` |
| Delivery days | `3` |
| Delivery begins | After usable source receipt (`source_receipt`) |
| Source ready | `true`, as asserted within this fictional example |
| Music rights | None (`none`) |
| Publish requested | `false` |

The catalog-fill shortcut copies offer terms, not rights/source assertions or model decisions. Resolve every original conflict explicitly; no note can waive the catalog. Confirm source grounding and rights only as applicable to your controlled synthetic demonstration, then save review. Separately inspect the saved scope, confirm scope and fixed catalog price, and record the **USD 35** quote. These controls are caller assertions, not identity verification or proof of legal rights.

1. Explicitly create the Sandbox order from the confirmed quote. The server pins its amount/currency/merchant and saves intent before sending a POST. It locks this scope after creation.
2. Open the Sandbox approval action. It opens a separate `www.sandbox.paypal.com` checkout tab without opener access. Log in with your separate **Sandbox Personal buyer**, never your real payment credentials.
3. Approve the test order. A return/cancel URL is only navigation, not success evidence. Return to the **original workspace** and explicitly check order status. No capture runs automatically.
4. When the server verifies approval, explicitly request capture. A verified completed test receipt requires separate order and capture lookups matching the original merchant, full amount, currency and reference data. No service is fulfilled.
5. A quote remains an immutable scope record with `paymentStatus: "not_started"`; read the separate payment panel for actual operation status. HTTP 200 can still mean `unknown`.

## Unknown results, sessions and limitations

If a request times out or its response is lost, use explicit status refresh/reconciliation. Do not create a replacement order, repeatedly capture or delete the private ledger. Unknown results are not success. An unknown create without an order ID requires operator investigation against Sandbox records; there is no invented lookup by request ID.

An unresolved payment blocks Clear. Completion permits Clear, which starts a fresh anonymous workspace and retains the journal. Session ownership and quotes are in memory, expiring after 45 idle minutes/eight hours or on server restart. The private journal survives; a new session cannot reclaim the old owner. Do not restart midway through approval as a retry strategy. A crash lock is never automatically removed; consult [PAYMENTS.md](PAYMENTS.md) before any recovery action.

No real funds, production account authentication, fulfillment, refund/webhook flow, always-on remote AI or universal hardware compatibility is claimed. The public [evidence summary](EVIDENCE.md) distinguishes actual desktop/Sandbox execution from offline tests, historical model omissions, and unverified mobile/accessibility coverage. No private development receipt is necessary to follow these instructions.
