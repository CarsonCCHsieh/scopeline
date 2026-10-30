# Public verification summary

This is a sanitized summary of the coordinating local verification on **2026-10-30**. It records observed behavior without exposing credentials, account identities, provider identifiers, cookies, raw responses, private journals or local user paths. It is not a raw provider audit log. Reproduce the working build using [JUDGING.md](JUDGING.md); private development receipts are not required or distributed.

## Actual PayPal Sandbox execution

Two fictional fixed-catalog Sandbox flows completed. No real funds or fulfillment were involved.

| Flow | Observed execution |
| --- | --- |
| **USD 45, manually reviewed API flow** | Native loopback HTTP created a server-priced order. Desktop Chrome used the distinct Sandbox Personal buyer to approve it. Server GET verified `APPROVED` before capture; approval alone did not capture. An explicit capture action followed. Independent order and capture lookups verified `COMPLETED`, the merchant, full USD amount and operation/quote linkage. |
| **USD 35, actual desktop UI with local AI** | The actual Chrome workspace made **one** local model request, showing **nine** proposals and **two** scope fields still needing explicit manual completion. The operator completed review/quote actions, approved using the Sandbox buyer and explicitly captured. Separate order/capture checks verified completion. This was an actual local AI/browser/provider flow, not a canned AI response or fake provider fixture. |

These observations apply to the coordinating owner's isolated Sandbox application/accounts. A different developer's free account onboarding and clean-machine setup have not been separately exercised. The own-Sandbox setup instructions describe that unverified reproduction path honestly and contain no credentials.

An early direct local Chrome navigation was blocked by the client. Following the normal PayPal return page's local-workspace link subsequently loaded the actual application DOM, enabling the later UI checks. The historical navigation error is not a claim that the final browser workflow remained blocked.

## Desktop and offline checks

- The actual desktop application was viewed in **English, Traditional Chinese and Japanese**. This is bounded desktop verification, not all UI state combinations, mobile or a complete accessibility audit.
- The coordinating full **offline suite passed 126/126 cases**, including nested cases. The suite covers domain validation, fake local-model transport, actual loopback HTTP with fake dependencies, controlled DOM/fetch behavior, durable payment operations, Sandbox transport and private configuration handling.
- Offline payment/model responses are synthetic. Tests do **not** call actual OAuth, PayPal or Ollama and do not constitute another real transaction or a representative model evaluation.
- The tested native runtime was **Node 24.14.0**. The application uses built-in Node modules and requires Node 24 or newer.

Historical intermediate suites passed 47, 84, 115 and 121 cases on earlier source snapshots. The 115-case backend run added nine payment HTTP, eighteen fake-fetch transport and four configuration cases to the 84-case snapshot; the 121-case run added six controlled payment-UI cases. These scopes are retained as history rather than presented as separate current full-suite passes.

## Known limits retained

Earlier three-case and revised four-case local-model probes had substantive omissions, including missing service identifiers, timing/source facts and caption language, plus inappropriate questions or attributions. A later simpler extraction and the actual USD 35 UI flow do not resolve that broader evaluation. Exact quotations and valid structure do not prove understanding. Review and deterministic catalog checks remain mandatory; see [AI.md](AI.md).

The following are **not** established by this summary: representative multilingual AI accuracy, clean judge-machine reproduction, universal model/hardware compatibility, all keyboard/visual/accessibility/mobile behavior, every recovery UI state, production authentication, always-on remote AI, public deployment or final event submission. Caller-supplied review/rights flags do not prove human understanding or rights ownership.

No private receipts or runtime ledger are linked as public evidence. Raw provider/account artifacts remain excluded. The public repository supplies source, tests, licensing, setup and this bounded summary; it must not contain secrets or test-buyer identities.
