/** Opt-in, single-run loopback integration probe. No browser or payment operation.
 * Synthetic machine assertions are not proof of a person's review or consent.
 * Default invocation only prints a plan. --run-once performs at most one inference.
 */
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { createScopeServer } from '../src/server.mjs';
import { createLocalExtractor, MODEL } from '../src/ai/ollama.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const ollama = 'http://127.0.0.1:11434';
const endpoint = `${ollama}/api/chat`;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const csp = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const sources = ['src/server.mjs', 'src/domain.mjs', 'src/contract.mjs', 'src/catalog.mjs', 'src/ai/ollama.mjs',
  'package.json', 'tools/flow-probe.mjs', 'public/index.html', 'public/help.html', 'public/styles.css',
  'public/app.mjs', 'public/i18n.mjs', 'public/help.mjs', 'docs/HTTP.md', 'docs/UI.md'];
const fields = ['sku', 'deliverables', 'secondsPerDeliverable', 'captionsLanguage', 'aspectRatio', 'revisions',
  'deliveryDays', 'deliveryStarts', 'sourceReady', 'musicRights', 'publishRequested'];
const aiBrief = 'CLEARED SYNTHETIC API PROBE. I request one English caption file. I need one revision. My source material is not ready. Deliver three days after usable source receipt. No music is needed. Do not publish.';
const manualBrief = 'CLEARED SYNTHETIC MANUAL API PROBE. Three thumbnail concepts, 16:9, one revision, three days after usable source receipt. Source is not ready. No music. Do not publish.';
const expectedAi = { sku: 'caption_pack', deliverables: 1, captionsLanguage: 'English', revisions: 1,
  sourceReady: false, deliveryDays: 3, deliveryStarts: 'source_receipt', musicRights: 'none', publishRequested: false };
class ProbeFailure extends Error { constructor(label) { super('Redacted probe failure'); this.label = label; } }
const safeCode = value => typeof value === 'string' && /^[a-z_]{1,64}$/.test(value) ? value : 'unclassified';

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== '--run-once') {
    process.stdout.write(JSON.stringify({ planOnly: true, command: 'node tools/flow-probe.mjs --run-once',
      binds: '127.0.0.1:0 (owned ephemeral server)', inferenceLimit: 1, model: MODEL,
      network: ['owned loopback HTTP server', `${ollama}/api/tags`, `${ollama}/api/show`, endpoint],
      externalNetwork: false, installs: false, downloads: false, browser: false, payments: false }) + '\n');
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const receiptPath = join(root, '.private', `flow-probe-${stamp}.json`);
  const receipt = { schema: 1, startedAt: new Date().toISOString(), finishedAt: null,
    purpose: 'Actual loopback HTTP integration with cleared synthetic input; machine API assertions only',
    claims: { realHumanReview: false, browserOrVisualQa: false, paymentIntegration: false,
      deployment: false, accountLogin: false, downloadedModels: false, installedPackages: false },
    syntheticInputs: [{ id: 'caption-ai-one-shot', sha256: sha(aiBrief) }, { id: 'thumbnail-manual-independent', sha256: sha(manualBrief) }],
    checks: [], modelPreflight: { status: 'not_run' }, ai: { status: 'not_run', chatCalls: 0 },
    manual: { status: 'not_run', humanConfirmationEvidence: false },
    server: { bind: '127.0.0.1', owned: true, port: null, closed: false }, sourceHashes: {},
    result: 'in_progress', failure: null };
  await mkdir(join(root, '.private'), { recursive: true });
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const save = () => writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  const check = (label, condition) => {
    receipt.checks.push({ check: label, pass: Boolean(condition) });
    if (!condition) throw new ProbeFailure(label);
  };
  let server;
  let chatCalls = 0;
  let phase = 'source_hashes';
  try {
    for (const path of sources) receipt.sourceHashes[path] = sha(await readFile(join(root, path)));
    const extractor = createLocalExtractor({ fetchImpl: async (url, init) => {
      if (url !== endpoint || init?.method !== 'POST' || chatCalls >= 1) throw new ProbeFailure('one_inference_transport_limit');
      chatCalls++;
      return fetch(url, init);
    } });
    server = createScopeServer({ extractor });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    check('owned_server_loopback_ephemeral', address && typeof address !== 'string' && address.address === '127.0.0.1' && address.port > 0);
    receipt.server.port = address.port;
    const base = `http://127.0.0.1:${address.port}`;
    const clients = { ai: { cookie: '', csrf: '' }, manual: { cookie: '', csrf: '' } };
    async function request(path, { client, body, csrf = true, cookieOverride, timeout = 8000 } = {}) {
      const headers = {};
      if (client?.cookie || cookieOverride) headers.Cookie = cookieOverride ?? client.cookie;
      if (body !== undefined) {
        headers.Origin = base;
        headers['Content-Type'] = 'application/json';
        if (csrf && client?.csrf) headers['X-CSRF-Token'] = client.csrf;
      }
      const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(timeout) });
      const bytes = Buffer.from(await response.arrayBuffer());
      let data = null;
      if ((response.headers.get('content-type') ?? '').startsWith('application/json')) data = JSON.parse(bytes.toString('utf8'));
      const cookie = response.headers.get('set-cookie');
      if (client && cookie) client.cookie = cookie.split(';', 1)[0];
      if (client && typeof data?.csrf === 'string') client.csrf = data.csrf;
      return { status: response.status, headers: response.headers, bytes, data, cookie };
    }
    const secureHeaders = (label, response) => {
      check(`${label}_csp`, response.headers.get('content-security-policy') === csp);
      check(`${label}_no_store_nosniff`, response.headers.get('cache-control') === 'no-store' && response.headers.get('x-content-type-options') === 'nosniff');
      check(`${label}_no_cors`, !response.headers.has('access-control-allow-origin'));
    };
    phase = 'public_surface';
    for (const [path, file, type] of [['/', 'index.html', 'text/html'], ['/help.html', 'help.html', 'text/html'],
      ['/styles.css', 'styles.css', 'text/css'], ['/app.mjs', 'app.mjs', 'text/javascript'],
      ['/i18n.mjs', 'i18n.mjs', 'text/javascript'], ['/help.mjs', 'help.mjs', 'text/javascript']]) {
      const res = await request(path);
      check(`${file}_status_mime_hash`, res.status === 200 && res.headers.get('content-type') === `${type}; charset=utf-8`
        && sha(res.bytes) === receipt.sourceHashes[`public/${file}`]);
      secureHeaders(file, res);
    }
    for (const path of ['/src/server.mjs', '/.env', '/.private/', '/tools/flow-probe.mjs']) {
      const res = await request(path);
      check(`private_path_blocked:${path}`, res.status === 404 && res.data?.error?.code === 'not_found');
    }
    phase = 'anonymous_sessions';
    for (const [name, client] of Object.entries(clients)) {
      const res = await request('/api/session', { client });
      check(`${name}_anonymous_session`, res.status === 200 && /^[a-f0-9]{64}$/.test(client.csrf)
        && res.data?.draft === null && res.data?.quote === null && res.data?.extraction === null);
      check(`${name}_cookie_boundary`, new RegExp(`^scopeline_session_${address.port}=[a-f0-9]{64}; HttpOnly; SameSite=Strict; Path=/$`).test(res.cookie ?? ''));
      check(`${name}_capability_boundaries`, res.data?.capabilities?.paypal === false && res.data?.capabilities?.persistence === 'session-memory'
        && res.data?.capabilities?.localAi === true);
      secureHeaders(`${name}_session`, res);
    }
    check('anonymous_sessions_distinct', clients.ai.cookie !== clients.manual.cookie && clients.ai.csrf !== clients.manual.csrf);
    const denied = await request('/api/drafts', { client: clients.ai, body: { mode: 'manual', rawBrief: manualBrief }, csrf: false });
    check('mutation_without_csrf_rejected', denied.status === 403 && denied.data?.error?.code === 'csrf_required');
    await save();

    phase = 'model_metadata_preflight';
    try {
      const tagsRes = await fetch(`${ollama}/api/tags`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
      if (!tagsRes.ok) throw new ProbeFailure('ollama_tags_status');
      const tags = await tagsRes.json();
      const selected = tags.models?.find(item => item.name === MODEL || item.model === MODEL);
      if (!selected || !/^[a-f0-9]{64}$/.test(selected.digest ?? '')) throw new ProbeFailure('required_model_not_confirmed');
      const showRes = await fetch(`${ollama}/api/show`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL }), redirect: 'error', signal: AbortSignal.timeout(5000) });
      if (!showRes.ok) throw new ProbeFailure('ollama_show_status');
      const show = await showRes.json();
      if (show.details?.format !== 'gguf' || show.remote_host || show.remote_model) throw new ProbeFailure('local_gguf_not_confirmed');
      if (typeof show.license !== 'string' || !/Apache License\s+Version 2\.0/.test(show.license)) throw new ProbeFailure('model_license_not_confirmed');
      receipt.modelPreflight = { status: 'confirmed_existing_local_model', model: MODEL, digest: selected.digest,
        sizeBytes: Number.isSafeInteger(selected.size) ? selected.size : null, format: show.details.format,
        quantization: show.details.quantization_level ?? null, parameterSize: show.details.parameter_size ?? null,
        licenseDeclaration: 'Locally installed model reports Apache License Version 2.0', licenseSha256: sha(show.license),
        metadataRequests: 2, downloaded: false };
    } catch (error) {
      receipt.modelPreflight = { status: 'not_confirmed', reason: error instanceof ProbeFailure ? error.label : 'metadata_request_failed', downloaded: false };
      receipt.ai.status = 'skipped_preflight_failed';
    }
    await save();
    phase = 'one_actual_local_inference';
    if (receipt.modelPreflight.status === 'confirmed_existing_local_model') {
      const start = Date.now();
      try {
        const res = await request('/api/drafts', { client: clients.ai, body: { rawBrief: aiBrief, mode: 'ai' }, timeout: 100000 });
        receipt.ai = { status: 'http_failure', httpStatus: res.status, elapsedMs: Date.now() - start,
          errorCode: safeCode(res.data?.error?.code), chatCalls };
        if (res.status === 201) {
          const draft = res.data?.draft;
          const proposals = Array.isArray(draft?.requestedRequirements) ? draft.requestedRequirements : [];
          const byField = Object.fromEntries(proposals.map(p => [p.field, p.value]));
          const observed = proposals.map(p => p.field).filter(f => fields.includes(f));
          const matched = Object.keys(expectedAi).filter(f => Object.hasOwn(byField, f) && byField[f] === expectedAi[f]);
          const missingExpected = Object.keys(expectedAi).filter(f => !Object.hasOwn(byField, f));
          const mismatched = Object.keys(expectedAi).filter(f => Object.hasOwn(byField, f) && byField[f] !== expectedAi[f]);
          const unexpected = observed.filter(f => !Object.hasOwn(expectedAi, f));
          const evidence = proposals.every(p => Number.isInteger(p.evidence?.start) && Number.isInteger(p.evidence?.end)
            && aiBrief.slice(p.evidence.start, p.evidence.end) === p.evidence.quote);
          const boundary = res.data?.extraction?.mode === 'ai' && res.data?.extraction?.requiresHumanReview === true
            && res.data?.extraction?.status === 'unverified_draft' && draft?.review === null && draft?.quoteId === null;
          receipt.ai = { status: boundary && evidence && missingExpected.length === 0 && mismatched.length === 0 && unexpected.length === 0
            ? 'single_synthetic_case_exact_expected_fields' : 'single_synthetic_case_has_gaps',
            httpStatus: 201, elapsedMs: Date.now() - start, chatCalls, observedFields: observed, matchedFields: matched,
            missingExpectedFields: missingExpected, mismatchedFields: mismatched, unexpectedFields: unexpected,
            validExactEvidenceSpans: evidence, requiresUnverifiedHumanReview: boundary,
            remainingScopeFields: (draft?.missingFields ?? []).filter(f => fields.includes(f)),
            catalogComparisonStatus: ['sku_missing', 'sku_unsupported', 'compared'].includes(draft?.catalogComparisonStatus) ? draft.catalogComparisonStatus : 'unknown',
            catalogConflictCount: Array.isArray(draft?.catalogConflicts) ? draft.catalogConflicts.length : null,
            modelQuestionCount: Array.isArray(draft?.missingQuestions) ? draft.missingQuestions.length : null,
            qualityGeneralization: 'One synthetic inference is not broad model-quality or human-review validation' };
          check('ai_response_remains_unverified_no_quote', boundary);
          const current = await request('/api/session', { client: clients.ai });
          check('ai_session_restore_no_quote', current.status === 200 && current.data?.draft?.id === draft.id && current.data?.quote === null);
        } else {
          const current = await request('/api/session', { client: clients.ai });
          check('failed_ai_no_automatic_manual_fallback_or_quote', current.status === 200 && current.data?.draft === null && current.data?.quote === null && current.data?.extraction === null);
        }
      } catch (error) {
        if (error instanceof ProbeFailure) throw error;
        receipt.ai = { status: 'request_failed_no_retry', elapsedMs: Date.now() - start, chatCalls };
      }
    }
    check('at_most_one_real_chat_request', chatCalls <= 1);
    await save();

    phase = 'independent_manual_machine_flow';
    const client = clients.manual;
    const created = await request('/api/drafts', { client, body: { rawBrief: manualBrief, mode: 'manual' } });
    check('manual_explicit_creation', created.status === 201 && created.data?.extraction?.mode === 'manual'
      && created.data?.draft?.requestedRequirements?.length === 0 && created.data?.draft?.missingFields?.length === 11
      && created.data?.draft?.catalogComparisonStatus === 'sku_missing' && created.data?.draft?.quoteId === null);
    const draft = created.data.draft;
    const scope = { sku: 'thumbnail_pack', deliverables: 3, secondsPerDeliverable: null, captionsLanguage: null,
      aspectRatio: '16:9', revisions: 1, deliveryDays: 3, deliveryStarts: 'source_receipt', sourceReady: false,
      musicRights: 'none', publishRequested: false };
    const reviewBody = { expectedVersion: draft.version, scope, decisions: [], resolutions: [], confirmSourceGrounding: true, confirmRights: true };
    const isolated = await request(`/api/drafts/${draft.id}/review`, { client: clients.ai, body: reviewBody });
    check('cross_session_draft_hidden', isolated.status === 404 && isolated.data?.error?.code === 'not_found');
    const unconfirmed = await request(`/api/drafts/${draft.id}/review`, { client, body: { ...reviewBody, confirmRights: false } });
    check('review_requires_explicit_assertions', unconfirmed.status === 422 && unconfirmed.data?.error?.code === 'confirmation_required');
    const reviewed = await request(`/api/drafts/${draft.id}/review`, { client, body: reviewBody });
    check('manual_review_saved_no_quote', reviewed.status === 200 && reviewed.data?.draft?.version === draft.version + 1
      && reviewed.data?.draft?.state === 'reviewed' && reviewed.data?.draft?.quoteId === null
      && reviewed.data?.draft?.review?.scope?.sourceReady === false
      && reviewed.data?.draft?.review?.confirmationBoundary === 'trusted_caller_assertion_only');
    const firstReviewed = reviewed.data.draft;
    const quoteBody = { expectedVersion: firstReviewed.version, reviewDigest: firstReviewed.review.digest,
      confirmScope: true, acceptCatalogPrice: true, expectedTotalCents: 4500 };
    const badPrice = await request(`/api/drafts/${draft.id}/quote`, { client, body: { ...quoteBody, expectedTotalCents: 1 } });
    check('quote_rejects_client_price_override', badPrice.status === 422 && badPrice.data?.error?.code === 'price_mismatch');
    const noQuoteConsent = await request(`/api/drafts/${draft.id}/quote`, { client, body: { ...quoteBody, confirmScope: false } });
    check('quote_requires_separate_confirmation', noQuoteConsent.status === 422 && noQuoteConsent.data?.error?.code === 'confirmation_required');
    const quoted = await request(`/api/drafts/${draft.id}/quote`, { client, body: quoteBody });
    check('fixed_catalog_quote_unpaid', quoted.status === 200 && quoted.data?.quote?.currency === 'USD'
      && quoted.data?.quote?.totalCents === 4500 && quoted.data?.quote?.paymentStatus === 'not_started'
      && quoted.data?.quote?.sandboxOnly === true && quoted.data?.quote?.items?.length === 1
      && quoted.data?.quote?.items[0]?.quantity === 1 && quoted.data?.quote?.confirmationBoundary === 'trusted_caller_assertion_only');
    const currentQuoted = await request('/api/session', { client });
    check('session_restores_current_quote', currentQuoted.status === 200 && currentQuoted.data?.quote?.id === quoted.data.quote.id);
    const changed = await request(`/api/drafts/${draft.id}/review`, { client,
      body: { ...reviewBody, expectedVersion: firstReviewed.version, scope: { ...scope, deliverables: 2 } } });
    check('scope_review_invalidates_quote', changed.status === 200 && changed.data?.draft?.version === firstReviewed.version + 1
      && changed.data?.draft?.quoteId === null && changed.data?.draft?.review?.scope?.deliverables === 2);
    const afterChange = await request('/api/session', { client });
    check('session_has_no_superseded_quote', afterChange.status === 200 && afterChange.data?.quote === null && afterChange.data?.draft?.state === 'reviewed');
    const stale = await request(`/api/drafts/${draft.id}/quote`, { client, body: quoteBody });
    check('superseded_quote_confirmation_rejected', stale.status === 409 && stale.data?.error?.code === 'stale_version');
    const next = changed.data.draft;
    const requoted = await request(`/api/drafts/${draft.id}/quote`, { client,
      body: { ...quoteBody, expectedVersion: next.version, reviewDigest: next.review.digest } });
    check('new_review_needs_new_quote_same_pack_price', requoted.status === 200 && requoted.data?.quote?.id !== quoted.data.quote.id
      && requoted.data?.quote?.totalCents === 4500 && requoted.data?.quote?.scope?.deliverables === 2);
    const oldCookie = client.cookie;
    const oldCsrf = client.csrf;
    const cleared = await request('/api/clear', { client, body: {} });
    check('clear_rotates_session_and_csrf', cleared.status === 200 && client.cookie !== oldCookie && client.csrf !== oldCsrf
      && /^[a-f0-9]{64}$/.test(client.csrf));
    check('clear_removes_accessible_workspace', cleared.data?.draft === null && cleared.data?.quote === null && cleared.data?.extraction === null);
    const revoked = await request('/api/clear', { client: { cookie: oldCookie, csrf: oldCsrf }, body: {} });
    check('old_session_cookie_revoked', revoked.status === 401 && revoked.data?.error?.code === 'session_required');
    const fresh = await request('/api/session', { client });
    check('fresh_session_remains_empty', fresh.status === 200 && fresh.data?.draft === null && fresh.data?.quote === null && fresh.data?.extraction === null);
    const clearedAi = await request('/api/clear', { client: clients.ai, body: {} });
    check('ai_workspace_cleared', clearedAi.status === 200 && clearedAi.data?.draft === null && clearedAi.data?.quote === null);
    receipt.manual = { status: 'http_machine_flow_passed', currency: 'USD', fixedPackCents: 4500,
      initialDeliverables: 3, changedDeliverables: 2, quoteInvalidationObserved: true,
      separateQuoteConfirmationRequired: true, clearRevocationObserved: true,
      humanConfirmationEvidence: false, paymentStatus: 'not_started', independentOfAiResult: true };
    receipt.result = receipt.ai.status === 'single_synthetic_case_exact_expected_fields'
      ? 'http_flow_passed_one_synthetic_ai_case_exact_no_broad_quality_claim'
      : 'http_flow_passed_ai_outcome_requires_attention';
  } catch (error) {
    receipt.failure = { phase, reason: error instanceof ProbeFailure ? error.label : 'unexpected_redacted_failure' };
    receipt.result = 'failed_no_retry';
    process.exitCode = 1;
  } finally {
    receipt.ai.chatCalls = chatCalls;
    if (server?.listening) {
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { server.closeAllConnections(); }, 5000);
          timer.unref();
          server.close(error => { clearTimeout(timer); error ? reject(error) : resolve(); });
          server.closeIdleConnections();
        });
        receipt.server.closed = true;
      } catch { receipt.server.closed = false; receipt.result = 'failed_owned_server_cleanup'; process.exitCode = 1; }
    }
    try {
      receipt.changedSourcesDuringRun = [];
      for (const path of sources) if (sha(await readFile(join(root, path))) !== receipt.sourceHashes[path]) receipt.changedSourcesDuringRun.push(path);
      if (receipt.changedSourcesDuringRun.length) { receipt.result = 'source_changed_during_probe'; process.exitCode = 1; }
    } catch { receipt.sourceComparison = 'incomplete'; process.exitCode = 1; }
    receipt.finishedAt = new Date().toISOString();
    await save();
    process.stdout.write(JSON.stringify({ receipt: relative(root, receiptPath).replaceAll('\\', '/'), result: receipt.result,
      checksPassed: receipt.checks.filter(c => c.pass).length, checksFailed: receipt.checks.filter(c => !c.pass).length,
      aiStatus: receipt.ai.status, actualChatRequests: chatCalls, ownedServerClosed: receipt.server.closed,
      failure: receipt.failure }) + '\n');
  }
}
main().catch(() => { process.stderr.write('Probe initialization or redacted receipt write failed. No error details were logged.\n'); process.exitCode = 1; });
