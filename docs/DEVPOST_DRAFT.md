# Submission record and story mirror

The [SCOPELINE entry](https://devpost.com/software/scopeline) was **submitted to the PayPal AI Hackathon on 2026-10-30**. This file retains its original filename and now mirrors the submitted project's English story and status. The [2:45 demo video is published Public](https://youtu.be/W0Y2Xd_4Kxs); playback was observed to eight seconds in the existing signed-in Chrome session, without a separate anonymous or full-length playback check. The application source is [commit `41b081d`](https://github.com/CarsonCCHsieh/scopeline/tree/41b081df96d331fdfb7bddae5c77aa2f150d0580); this document records later evidence without changing that application.

Project: **SCOPELINE**

Pitch: **Turn an unclear brief into a reviewed scope and fixed quote. Local AI proposes; you decide. PayPal Sandbox connects approval to a server-verified test receipt.**

Working build: [public source](https://github.com/CarsonCCHsieh/scopeline), [complete local setup](JUDGING.md), [bounded evidence](EVIDENCE.md). The manual review and unpaid quote run without AI or credentials. Actual AI and payment evaluation require the judge's own local model and Sandbox settings; no hosted AI or shared owner key is supplied.

## Inspiration

A creator-service brief can request quantities, deadlines or revisions that a fixed offer does not support. In local experiments, an extractor found requested quantities while omitting the corresponding catalog conflicts. It also attributed a seller restriction to the buyer. SCOPELINE grew from that observed gap: make each interpretation inspectable before it becomes a quote or payment request. The three offers are fictional demonstration data, with no real service offered for sale.

## What it does

SCOPELINE is an English, Traditional Chinese and Japanese local workbench. A creator pastes a cleared brief and deliberately requests a real local AI draft. Every proposed requirement carries a quotation from the unchanged source. Missing fields and catalog comparisons are computed separately. The reviewer accepts, corrects or rejects each attribution, completes all eleven final scope fields and records resolutions for the original conflicts. A complete catalog-compatible review can then be confirmed as a fixed-price quote.

The PayPal Sandbox workflow starts only after a separate explicit action. It creates an order for the server's quote amount, opens buyer approval and requires a server status check before explicit capture. Only independently checked completed order and capture evidence produces the completed test receipt. A return URL, model response or HTTP 200 is insufficient. No real funds or fulfillment are involved.

## How we built it

The application uses native Node.js modules, a buildless HTML/CSS/JavaScript interface and local Ollama qwen3.5:9b. There are no npm runtime dependencies or external interface assets. The extractor sends the brief and fictional service names to the loopback model endpoint. It uses structured output and one bounded request without automatic retry. Trusted code validates exact quotation spans and field types; deterministic catalog code owns limits and integer-cent prices.

The controller binds to IPv4 loopback and derives anonymous workspace ownership from a session cookie, with Host, Origin, CSRF and request-size checks. A separate private durable journal records payment intent and stable request IDs. The Sandbox adapter pins the quote, merchant, amount and currency, handles uncertain outcomes conservatively and never automatically retries a create or capture POST. Completion requires independent order and capture GET verification. Credentials remain server-side and outside the model input and public source.

## Challenges we ran into

Model omissions were material. Earlier four-case probes still missed facts or service identifiers, and exact source quotations did not establish correct interpretation. Those failures remain documented. Manual completion, attribution review and deterministic catalog checks are mandatory. Payment state also needed its own authority: an immutable quote is a scope record, while the separate payment panel reports the verified Sandbox operation. Lost responses and interrupted sessions require reconciliation rather than a replacement charge. Production identity and recovery-login design remain unresolved.

## Accomplishments

Three distinct actual Sandbox flows completed: a USD 45 manually reviewed API path with browser buyer approval, an earlier USD 35 AI/desktop-browser path and a new USD 35 AI/desktop-browser demonstration. The new flow used a 217-character synthetic brief and one local model request. It produced seven proposals, four missing fields and no original catalog flags. All seven proposals were individually reviewed and accepted; the four missing fields were manually completed before saving all eleven final fields and confirming the fixed USD 35 quote. One create action, buyer approval, server-verified approval and one capture action led to server-verified completion. The third journal record is separate from the earlier two.

The third completed state was viewed in English, Traditional Chinese and Japanese at a 1280 × 720 desktop viewport. The coordinating offline suite passed 126 cases, and a fresh local clone of the public application commit also passed 126/126 with no private configuration, model inference or provider calls. Those fake-provider tests are distinct from the three actual Sandbox executions. The MIT repository includes source, complete local setup, tests and a sanitized evidence summary.

## What we learned

A useful AI draft needs visible provenance, unresolved fields and a deliberate correction path. A simple completed example does not erase earlier failures or establish representative AI accuracy. Zero catalog flags do not fill missing values. Explicit review controls provide a caller boundary, but do not prove understanding, identity or media rights. A verified Sandbox receipt is evidence about that test operation, not production readiness or fulfillment.

## What's next

Next steps are representative model evaluation, mobile and broader accessibility review, clean judge-machine model/account setup, and authenticated ownership and recovery before production use. The local prototype uses fictional offers and Sandbox funds. It does not claim an always-on hosted AI service, real-money checkout or fulfilled services.


## Run it locally

[MIT source repository](https://github.com/CarsonCCHsieh/scopeline) · [Complete judge setup and runnable build](https://github.com/CarsonCCHsieh/scopeline/blob/main/docs/JUDGING.md). A Node-only manual review and unpaid quote path works without a model or payment keys; the full AI and Sandbox path uses your own local model and free Sandbox account.
