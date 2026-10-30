# Public verification summary

This is a sanitized summary of the coordinating local verification on **2026-10-30**. It records observed behavior without exposing credentials, account identities, provider identifiers, cookies, raw responses, private journals or local user paths. It is not a raw provider audit log. Reproduce the working build using [JUDGING.md](JUDGING.md); private development receipts are not required or distributed.

## Actual PayPal Sandbox execution

Three distinct fictional fixed-catalog Sandbox flows completed. No real funds or fulfillment were involved. The third was a new execution, rather than a replay of either earlier flow.

| Flow | Observed execution |
| --- | --- |
| **USD 45, manually reviewed API flow** | Native loopback HTTP created a server-priced order. Desktop Chrome used the distinct Sandbox Personal buyer to approve it. Server GET verified `APPROVED` before capture; approval alone did not capture. An explicit capture action followed. Independent order and capture lookups verified `COMPLETED`, the merchant, full USD amount and operation/quote linkage. |
| **USD 35, actual desktop UI with local AI** | The actual Chrome workspace made **one** local model request, showing **nine** proposals and **two** scope fields still needing explicit manual completion. The operator completed review/quote actions, approved using the Sandbox buyer and explicitly captured. Separate order/capture checks verified completion. This was an actual local AI/browser/provider flow, not a canned AI response or fake provider fixture. |
| **USD 35, new desktop UI demonstration with local AI** | A different **217-character synthetic brief** made **one** local `qwen3.5:9b` request. The draft showed **seven** proposals, **four** missing fields and **zero original catalog flags**. All seven proposals were individually accepted after review; the operator manually completed the four missing fields and saved all **eleven** final fields. A fixed USD 35 quote led to one explicit create action, Sandbox buyer approval, a server check of `APPROVED` and one explicit capture action. The UI then showed server-verified `COMPLETED` capture. Four workflow steps were confirmed. |

For the third flow, the private durable journal retained a third, separate completed caption operation, with USD 35, `COMPLETED` order/capture status and a verification timestamp of **2026-10-30 09:16:27 UTC**. It retains the earlier USD 45 and USD 35 operations separately. In the application, completion can be recorded only after a separate order GET and capture GET validate the pinned amount, currency, merchant and reference relationships; neither the capture POST response nor a return-page query can mark completion. This summary inspected that retained state and the source rule without making another provider request. It does not publish raw provider responses or identifiers.

Zero original catalog flags did not make the third draft complete: four required values were still absent and had to be reviewed and supplied. This simple compatible caption example does not test all conflict paths or establish general extraction accuracy. All examples used controlled fictional content; review assertions do not establish another person's understanding or rights.

These observations apply to the coordinating owner's isolated Sandbox application/accounts. A different developer's free account onboarding and clean-machine setup have not been separately exercised. The own-Sandbox setup instructions describe that unverified reproduction path honestly and contain no credentials.

An early direct local Chrome navigation was blocked by the client. Following the normal PayPal return page's local-workspace link subsequently loaded the actual application DOM, enabling the later UI checks. The historical navigation error is not a claim that the final browser workflow remained blocked.

## Desktop and offline checks

- The actual desktop application was viewed in **English, Traditional Chinese and Japanese**. The third flow's completed state was captured at a **1280 × 720** viewport in all three languages; English approval and completed-payment views were also captured. This is bounded desktop verification, not all UI state combinations, mobile or a complete accessibility audit.
- The coordinating full **offline suite passed 126/126 cases**, including nested cases. The suite covers domain validation, fake local-model transport, actual loopback HTTP with fake dependencies, controlled DOM/fetch behavior, durable payment operations, Sandbox transport and private configuration handling.
- Offline payment/model responses are synthetic. Tests do **not** call actual OAuth, PayPal or Ollama and do not constitute another real transaction or a representative model evaluation.
- The tested native runtime was **Node 24.14.0**. The application uses built-in Node modules and requires Node 24 or newer.

## Fresh public clone and source boundary

A separate fresh local clone of the public [application commit `41b081d`](https://github.com/CarsonCCHsieh/scopeline/tree/41b081df96d331fdfb7bddae5c77aa2f150d0580) contained the expected **39 tracked files** and passed **126/126** offline cases on Node **24.14.0**. The checkout remained clean and its source files unchanged after the run. No private configuration was loaded; no Ollama or PayPal request ran. This proves a clean-clone offline run on the coordinating environment, not model installation on new judge hardware, another developer's Sandbox onboarding, browser operation or remote availability.

This documentation update records later evidence for that application source. It does not claim the updated documentation was part of the earlier tested commit, create a new application release or rerun the test suite.

Historical intermediate suites passed 47, 84, 115 and 121 cases on earlier source snapshots. The 115-case backend run added nine payment HTTP, eighteen fake-fetch transport and four configuration cases to the 84-case snapshot; the 121-case run added six controlled payment-UI cases. These scopes are retained as history rather than presented as separate current full-suite passes.

## Published demo and submission

The [2:45 demo video](https://youtu.be/W0Y2Xd_4Kxs) was published **Public** on YouTube on 2026-10-30. Studio confirmed publication. In the existing signed-in Chrome session, actual playback advanced from **0:00 to 0:08**, then paused. Anonymous access and full-length playback were not separately verified.

Devpost confirmed the [SCOPELINE submission to the PayPal AI Hackathon](https://devpost.com/software/scopeline) on **2026-10-30**, with the submitted confirmation and edit-submission action visible. [DEVPOST_DRAFT.md](DEVPOST_DRAFT.md) retains its filename and now serves as a submitted-project story mirror. The working build remains the repository plus complete local setup.

## Known limits retained

Earlier three-case and revised four-case local-model probes had substantive omissions, including missing service identifiers, timing/source facts and caption language, plus inappropriate questions or attributions. Later simple extractions and the two actual USD 35 UI flows do not resolve that broader evaluation. Exact quotations and valid structure do not prove understanding. Review and deterministic catalog checks remain mandatory; see [AI.md](AI.md).

The following are **not** established by this summary: representative multilingual AI accuracy, clean judge-machine model/account setup, universal model/hardware compatibility, all keyboard/visual/accessibility/mobile behavior, every recovery UI state, production authentication, always-on remote AI or public deployment. Caller-supplied review/rights flags do not prove human understanding or rights ownership.

No private receipts or runtime ledger are linked as public evidence. Raw provider/account artifacts remain excluded. The public repository supplies source, tests, licensing, setup and this bounded summary; it must not contain secrets or test-buyer identities.
