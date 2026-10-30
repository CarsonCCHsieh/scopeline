import { applyTranslations, getLanguage, money, setLanguage, t } from './i18n.mjs';
import { createOperationGate, isCurrentQuote, sameQuoteTarget, sameReviewContext } from './workspace-state.mjs';
import { canCapturePayment, paymentAmountCents, paymentDisplayState, paymentMatchesQuote, sandboxApprovalUrl, validPayment } from './payment-state.mjs';

const $ = id => document.getElementById(id);
const fields = ['sku','deliverables','secondsPerDeliverable','captionsLanguage','aspectRatio','revisions','deliveryDays','deliveryStarts','sourceReady','musicRights','publishRequested'];
const numbers = new Set(['deliverables','secondsPerDeliverable','revisions','deliveryDays']);
const nullable = new Set(['secondsPerDeliverable','captionsLanguage','aspectRatio']);
const booleans = new Set(['sourceReady','publishRequested']);
const state = { csrf:null, catalog:[], restrictions:[], capabilities:{}, activity:{}, draft:null, quote:null, extraction:null, busy:false, ready:false, dirty:false, needsSync:false, payment:null, paymentUncertain:false, paymentError:null, paymentReconciledId:null, sandboxConsent:false };
const operations = createOperationGate();
const controls = new Map();
const decisions = new Map();
const resolutions = new Map();
const sample = '[CLEARED SYNTHETIC SAMPLE — NOT A REAL CUSTOMER]\nI need the Three short highlights service: three clips, up to 30 seconds each, English captions, 9:16 format and one revision round. Please allow five days after usable source material is received. The source files are ready. No music is needed. Do not publish the clips.';

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key,value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'checked' || key === 'disabled' || key === 'hidden') node[key] = Boolean(value);
    else node.setAttribute(key, String(value));
  }
  for (const child of children) if (child !== undefined && child !== null) node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  return node;
}
const translated = (tag,key,attrs={}) => el(tag,{'data-i18n':key,...attrs,text:t(key)});
const option = (value,key) => translated('option',key,{value});
const offerName = offer => ['clip_pack','thumbnail_pack','caption_pack'].includes(offer.sku) ? t(`offer_${offer.sku}`) : offer.name;
const findOffer = sku => state.catalog.find(offer => offer.sku === sku);
function displayValue(value, field) {
  if (value === null) return t('nullValue');
  if (typeof value === 'boolean') return t(value ? 'yes':'no');
  if (field === 'sku') { const offer=findOffer(value); if (offer) return offerName(offer); }
  if (field === 'deliveryStarts' && ['source_receipt','calendar_now','unspecified'].includes(value)) return t(value);
  if (field === 'musicRights' && ['none','licensed','unlicensed','unknown'].includes(value)) return t(value);
  return String(value);
}
function notify(key,kind='info',detail='') {
  const node=$('notice'); node.hidden=false; node.dataset.kind=noticeKind(key,kind); node.dataset.baseKind=kind; node.dataset.message=key; node.dataset.detail=detail;
  node.textContent=noticeText(key)+(detail ? ` ${detail}`:'');
}
function refreshNotice() { const n=$('notice'); if (!n.hidden && n.dataset.message) {n.textContent=noticeText(n.dataset.message)+(n.dataset.detail ? ` ${n.dataset.detail}`:'');n.dataset.kind=noticeKind(n.dataset.message,n.dataset.baseKind || n.dataset.kind);} }
function paymentDisplay() { return paymentDisplayState({payment:state.payment,quote:state.quote,uncertain:state.paymentUncertain,needsSync:state.needsSync,inFlight:operations.kind==='payment'}); }
function quoteStatusKey() { return ({not_started:'confirmedQuote',in_progress:'quoteSandboxInProgress',unverified:'quoteSandboxUnverified',verified:'quoteSandboxVerified'})[paymentDisplay()]; }
function noticeKind(key,kind) {
  if (!['paymentStatus','confirmedQuote','connected','statusRefreshed','clearReconciled'].includes(key)) return kind;
  return ({unverified:'error',verified:'success',in_progress:kind==='busy' ? 'busy':'info'})[paymentDisplay()] || kind;
}
function noticeText(key) {
  if (key==='paymentStatus' || key==='confirmedQuote') return t(quoteStatusKey());
  const summary=['connected','statusRefreshed','clearReconciled'].includes(key) && paymentDisplay()!=='not_started' ? ` ${t(quoteStatusKey())}`:'';
  return t(key)+summary;
}
class ApiError extends Error { constructor(code,message) { super(message); this.code=code; } }
async function request(path,{method='GET',body,timeout=20000}={}) {
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),timeout);
  try {
    const headers={Accept:'application/json'};
    if (method !== 'GET') {
      if (!state.csrf) throw new ApiError('session_unavailable',t('sessionError'));
      headers['Content-Type']='application/json'; headers['X-CSRF-Token']=state.csrf;
    }
    const response=await fetch(path,{method,headers,credentials:'same-origin',mode:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal,...(body === undefined ? {}:{body:JSON.stringify(body)})});
    if (!response.headers.get('content-type')?.includes('application/json')) throw new ApiError('invalid_response',t('requestFailed'));
    const text=await response.text(); if (text.length>200000) throw new ApiError('response_too_large',t('requestFailed'));
    let data; try { data=JSON.parse(text); } catch { throw new ApiError('invalid_response',t('requestFailed')); }
    if (!response.ok) throw new ApiError(typeof data.error?.code==='string' ? data.error.code:'request_failed', typeof data.error?.message==='string' ? data.error.message:t('requestFailed'));
    return data;
  } catch(error) {
    if (error.name==='AbortError') throw new ApiError('timeout',t('timeout'));
    throw error;
  } finally { clearTimeout(timer); }
}
function showError(error) {
  if (error.code && /busy|concurrency/.test(error.code)) state.activity.aiBusy=true;
  notify(error.code==='timeout' ? 'timeout':'requestFailed','error',error.code==='timeout' ? '' : `${error.code ? `[${error.code}] `:''}${error.message || ''}`);
}
function updateActivity() {
  $('activity-status').textContent=state.needsSync ? t('syncRequired') : paymentDisplay()!=='not_started' ? t(quoteStatusKey()) : state.activity.workspaceBusy ? t('workspaceBusy') : state.activity.aiBusy ? t('aiBusy') : (!state.capabilities.localAi && state.ready ? t('aiUnavailable'):'');
  const locked=Boolean(state.draft);
  const hasText=Boolean($('raw-brief').value.trim());
  const blocked=!state.ready || state.needsSync || state.busy || paymentLocksWorkspace();
  $('ai-button').disabled=blocked || locked || !hasText || !state.capabilities.localAi || Boolean(state.activity.aiBusy) || Boolean(state.activity.workspaceBusy);
  $('manual-button').disabled=blocked || locked || !hasText || Boolean(state.activity.workspaceBusy);
  $('sample-button').disabled=blocked || locked;
  $('refresh-session').disabled=state.busy;
  $('clear-button').disabled=!canClear();
}
function canClear() {
  return state.ready && !state.needsSync && !state.paymentUncertain && (!state.payment || state.payment.state==='completed') && (!operations.busy || operations.kind==='ai');
}
function renderBusy() {
  state.busy=operations.busy;
  const blocked=state.busy || state.needsSync || !state.ready || paymentLocksWorkspace();
  $('brief-controls').disabled=blocked;
  $('review-controls').disabled=blocked;
  $('quote-controls').disabled=blocked;
  $('confirm-clear').disabled=!canClear();
  $('cancel-clear').disabled=operations.kind==='clear';
  document.body.setAttribute('aria-busy',String(state.busy));
  updateDerived();
}
function beginOperation(kind,options) { const op=operations.begin(kind,options);renderBusy();return op; }
function finishOperation(op) { if (operations.finish(op)) renderBusy(); }
function renderCatalog() {
  const list=$('catalog-list'); list.replaceChildren();
  for (const offer of state.catalog) {
    const terms=t('offerTerms',{count:offer.maxDeliverables,revisions:offer.maxRevisions,days:offer.minDeliveryDays});
    const extra=[offer.maxSeconds===null ? null:t('durationTerms',{seconds:offer.maxSeconds}),offer.captionsLanguage,offer.aspectRatio].filter(Boolean).join(' · ');
    list.append(el('article',{class:'catalog-card'},el('div',{class:'catalog-card-head'},el('strong',{text:offerName(offer)}),el('span',{class:'catalog-price',text:money(offer.priceCents,offer.currency)})),el('p',{class:'catalog-terms',text:terms}),...(extra ? [el('p',{class:'catalog-terms',text:extra})]:[])));
  }
  $('catalog-version').textContent=state.catalogVersion || '';
  const rules=$('system-rules'); rules.replaceChildren();
  for (const rule of state.restrictions) rules.append(el('li',{text:['catalog_price_only','no_publication','rights_required','source_receipt_anchor','sandbox_only'].includes(rule.code) ? t(`rule_${rule.code}`):rule.text,title:rule.text}));
}
function setControl(control,value) {
  if (nullable.has(control.field)) {
    control.mode.value=value===undefined ? '' : value===null ? 'null':'value';
    control.input.value=value===undefined || value===null ? '' : String(value);
    control.input.hidden=control.mode.value!=='value';
    control.input.disabled=control.mode.value!=='value';
  } else control.input.value=value===undefined ? '' : String(value);
}
function renderScope(scope) {
  controls.clear(); const grid=$('scope-fields'); grid.replaceChildren();
  const proposed=new Set(state.draft.requestedRequirements.map(item=>item.field));
  for (const field of fields) {
    const id=`scope-${field}`; const box=el('div',{class:'scope-field','data-proposed':String(proposed.has(field))});
    box.append(translated('label',field,{for:nullable.has(field) ? `${id}-mode`:id}));
    let input,mode;
    if (nullable.has(field)) {
      mode=el('select',{id:`${id}-mode`,'data-scope-field':field},option('','pending'),option('null','notApplicable'),option('value','specified'));
      input=el('input',{id,type:numbers.has(field) ? 'number':'text',class:'nullable-value','aria-label':t(field),'data-label-field':field,maxlength:64,...(numbers.has(field)?{min:1,max:3600,step:1}:{})});
      box.append(mode,input);
      mode.addEventListener('change',()=>{ input.hidden=mode.value!=='value'; input.disabled=mode.value!=='value'; });
    } else if (field==='sku') {
      input=el('select',{id},option('','pending'));
      for (const offer of state.catalog) input.append(el('option',{value:offer.sku,'data-offer-sku':offer.sku,text:offerName(offer)}));
      if (scope[field]!==undefined && !findOffer(scope[field])) input.append(el('option',{value:scope[field],text:String(scope[field])}));
      box.append(input);
    } else if (booleans.has(field)) { input=el('select',{id},option('','pending'),option('true','yes'),option('false','no')); box.append(input); }
    else if (field==='deliveryStarts' || field==='musicRights') {
      input=el('select',{id},option('','pending'));
      const values=field==='deliveryStarts' ? ['source_receipt','calendar_now','unspecified']:['none','licensed','unlicensed','unknown'];
      for (const value of values) input.append(option(value,value)); box.append(input);
    } else { input=el('input',{id,type:'number',min:field==='revisions'?0:1,max:100,step:1,inputmode:'numeric'}); box.append(input); }
    const control={field,input,mode}; controls.set(field,control); setControl(control,scope[field]); grid.append(box);
  }
}
function renderProposals() {
  decisions.clear(); const list=$('proposal-list'); list.replaceChildren();
  const saved=state.draft.review?.decisions || [];
  for (const [index,proposal] of state.draft.requestedRequirements.entries()) {
    const current=saved.find(item=>item.field===proposal.field);
    const select=el('select',{id:`decision-${index}`},option('','pending'),option('accept','accept'),option('correct','correct'),option('not_requested','not_requested'));
    const note=el('textarea',{id:`decision-note-${index}`,maxlength:300,rows:2});
    select.value=current?.decision || ''; note.value=current?.note || '';
    const noteLabel=translated('label',select.value==='accept'?'noteOptional':'noteRequired',{for:note.id});
    select.addEventListener('change',()=>{noteLabel.dataset.i18n=select.value==='accept'?'noteOptional':'noteRequired';noteLabel.textContent=t(noteLabel.dataset.i18n);note.required=select.value!=='accept';});
    const jump=translated('button','showSource',{type:'button',class:'source-jump'});
    jump.addEventListener('click',()=>{const source=$('raw-brief');source.focus();source.setSelectionRange(proposal.evidence.start,proposal.evidence.end);source.scrollIntoView({block:'center'});});
    const card=el('article',{class:'proposal-card'},el('div',{class:'proposal-heading'},translated('strong',proposal.field),el('span',{class:'proposal-value',text:JSON.stringify(proposal.value)})),el('blockquote',{text:proposal.evidence.quote}),jump,translated('label','decision',{for:select.id}),select,noteLabel,note);
    list.append(card); decisions.set(proposal.field,{select,note});
  }
  if (!decisions.size) list.append(translated('p','noProposals',{class:'empty-proposals'}));
  $('proposal-count').textContent=String(decisions.size);
  const questions=$('model-questions'); questions.replaceChildren();
  for (const question of state.draft.missingQuestions) questions.append(el('li',{text:question}));
  if (!state.draft.missingQuestions.length) questions.append(translated('li','noQuestions'));
}
function renderConflicts() {
  resolutions.clear(); const list=$('conflict-list');list.replaceChildren();
  const saved=state.draft.review?.resolutions || [];
  for (const [index,conflict] of state.draft.catalogConflicts.entries()) {
    const current=saved.find(item=>item.conflictId===conflict.id);
    const check=el('input',{type:'checkbox',id:`resolution-${index}`,checked:current?.action==='accept_catalog_terms'});
    const note=el('textarea',{id:`resolution-note-${index}`,maxlength:300,rows:2}); note.value=current?.note || '';
    list.append(el('article',{class:'conflict-card'},el('div',{class:'conflict-title'},el('span',{class:'flag-index',text:String(index+1).padStart(2,'0')}),translated('strong',conflict.field)),el('p',{class:'conflict-original',text:conflict.message}),el('label',{class:'check-row',for:check.id},check,translated('span','acceptTerms')),translated('label','noteRequired',{for:note.id,class:'note-label'}),note));
    resolutions.set(conflict.id,{check,note});
  }
  if (!resolutions.size) list.append(translated('p','noOriginalConflicts',{class:'section-description'}));
  $('conflict-count').textContent=String(resolutions.size);
}
function renderDraft() {
  const draft=state.draft;
  $('empty-state').hidden=Boolean(draft); $('draft-workspace').hidden=!draft;
  $('source-lock').hidden=!draft; $('raw-brief').readOnly=Boolean(draft);
  if (!draft) {
    controls.clear(); decisions.clear(); resolutions.clear();
    for (const id of ['scope-fields','proposal-list','conflict-list','model-questions','quote-content']) $(id).replaceChildren();
    for (const id of ['confirm-grounding','confirm-rights','confirm-scope','confirm-price']) $(id).checked=false;
    $('attribution-meta').textContent='';$('original-comparison').textContent='';
    $('proposal-count').textContent='0';$('conflict-count').textContent='0';$('quote-form').hidden=true;
    updateDerived();return;
  }
  $('raw-brief').value=draft.rawBrief;
  $('sample-label').hidden=!draft.rawBrief.startsWith('[CLEARED SYNTHETIC SAMPLE');
  const initial=draft.review?.scope || Object.fromEntries(draft.requestedRequirements.map(item=>[item.field,item.value]));
  renderScope(initial); renderProposals(); renderConflicts();
  $('confirm-grounding').checked=false; $('confirm-rights').checked=false;
  $('confirm-scope').checked=false; $('confirm-price').checked=false;
  state.dirty=false;
  applyTranslations(); updateDerived();
}
function readScope() {
  const scope={},missing=[];
  for (const field of fields) {
    const control=controls.get(field); if (!control) {missing.push(field);continue;}
    const {input,mode}=control;
    if (mode?.value==='null') { scope[field]=null;continue; }
    if (mode && mode.value!=='value') {missing.push(field);continue;}
    const text=input.value;
    if (!text.trim()) {missing.push(field);continue;}
    if (numbers.has(field)) {
      const value=Number(text),min=field==='revisions'?0:1,max=field==='secondsPerDeliverable'?3600:100;
      if (!Number.isSafeInteger(value) || value<min || value>max) {missing.push(field);continue;} scope[field]=value;
    } else if (booleans.has(field)) {
      if (!['true','false'].includes(text)) {missing.push(field);continue;}scope[field]=text==='true';
    } else if (text.length>64) missing.push(field);
    else scope[field]=text;
  }
  return {scope,missing};
}
// A client-side working comparison, never the saved review's authority.
// It uses the server-supplied catalog. The final POST revalidates in the domain.
function compare(scope) {
  const issues=[]; const add=(key,vars={})=>issues.push({key,vars}); const offer=findOffer(scope.sku);
  if (scope.sku!==undefined && !offer) add('flag_unsupported_sku');
  if (offer) {
    for (const [field,limit] of [['deliverables',offer.maxDeliverables],['revisions',offer.maxRevisions]]) if (scope[field]!==undefined && scope[field]>limit) add('flag_above_catalog_limit',{field:t(field),limit});
    if (scope.deliveryDays!==undefined && scope.deliveryDays<offer.minDeliveryDays) add('flag_too_soon',{days:offer.minDeliveryDays});
    if (scope.secondsPerDeliverable!==undefined && scope.secondsPerDeliverable!==null && (offer.maxSeconds===null || scope.secondsPerDeliverable>offer.maxSeconds)) add('flag_unsupported_duration');
    if (offer.maxSeconds!==null && scope.secondsPerDeliverable===null) add('flag_unsupported_duration');
    for (const field of ['captionsLanguage','aspectRatio']) if (scope[field]!==undefined && scope[field]!==offer[field]) add('flag_unsupported_option',{field:t(field)});
  }
  if (scope.deliveryStarts!==undefined && scope.deliveryStarts!=='source_receipt') add('flag_invalid_anchor');
  if (scope.musicRights!==undefined && !['none','licensed'].includes(scope.musicRights)) add('flag_rights_unconfirmed');
  if (scope.publishRequested===true) add('flag_publication_unsupported');
  return {offer,issues};
}
function reviewReadiness() {
  const {scope,missing}=readScope(); const comparison=compare(scope);const decisionPayload=[],resolutionPayload=[];let pendingDecisions=0,pendingResolutions=0,mismatch=false;
  for (const proposal of state.draft?.requestedRequirements || []) {
    const ui=decisions.get(proposal.field),decision=ui.select.value,note=ui.note.value;
    if (!['accept','correct','not_requested'].includes(decision) || note.length>300 || (decision!=='accept' && !note.trim())) pendingDecisions++;
    if (decision==='accept' && scope[proposal.field]!==proposal.value) {pendingDecisions++;mismatch=true;}
    decisionPayload.push({field:proposal.field,decision,note});
  }
  for (const conflict of state.draft?.catalogConflicts || []) {
    const ui=resolutions.get(conflict.id),note=ui.note.value;
    if (!ui.check.checked || !note.trim() || note.length>300) pendingResolutions++;
    resolutionPayload.push({conflictId:conflict.id,action:'accept_catalog_terms',note});
  }
  const complete=state.draft && !missing.length && comparison.offer && !comparison.issues.length && !pendingDecisions && !pendingResolutions && $('confirm-grounding').checked && $('confirm-rights').checked;
  return {scope,missing,comparison,decisionPayload,resolutionPayload,pendingDecisions,pendingResolutions,mismatch,complete};
}
function renderComparison(readiness) {
  const {missing,comparison}=readiness,box=$('working-comparison');box.replaceChildren();
  const key=!comparison.offer ? 'comparisonPending' : comparison.issues.length ? 'comparisonConflict':missing.length ? 'comparisonIncomplete':'comparisonClear';
  box.dataset.status=!comparison.offer ? 'pending':comparison.issues.length ? 'conflict':missing.length ? 'pending':'clear';
  box.append(el('strong',{text:t(key)}));
  if (!comparison.offer) box.append(translated('p','comparisonMissing'));
  if (missing.length) box.append(el('p',{text:t('missingFields',{fields:missing.map(field=>t(field)).join(' · ')})}));
  if (comparison.issues.length) {const list=el('ul');for (const issue of comparison.issues) list.append(el('li',{text:t(issue.key,issue.vars)}));box.append(list);}
  box.append(translated('p','comparisonCaveat'));
}
function renderQuote() {
  const content=$('quote-content');content.replaceChildren();
  const review=state.draft?.review,offer=review ? findOffer(review.scope.sku):null;
  const current=isCurrentQuote(state);
  const ready=Boolean(state.ready && review && offer && !state.dirty && !state.needsSync);
  $('quote-form').hidden=!ready || current;
  if (!ready) {content.append(translated('p',state.needsSync ? 'syncRequired':state.dirty && review ? 'quoteDirty':'quoteNeedsReview',{class:'quote-pending'}));return;}
  content.append(el('div',{class:'quote-total-row'},el('div',{},el('p',{class:'quote-total-label',text:offerName(offer)}),translated('p',current ? quoteStatusKey():'notQuote',{class:'quote-kind'})),el('strong',{class:'quote-total',text:money(current ? state.quote.totalCents:offer.priceCents,current ? state.quote.currency:offer.currency)})));
  content.append(translated('p','packPrice',{class:'microcopy'}));
  const definition=el('dl',{class:'quote-scope'});
  for (const field of fields) definition.append(el('div',{},el('dt',{text:t(field)}),el('dd',{text:displayValue(review.scope[field],field)})));
  content.append(definition);
  if (current) content.append(translated('p',quoteStatusKey(),{class:'quote-confirmed'}),el('p',{class:'quote-id',text:`${t('quoteReference')}: ${state.quote.id}`}));
  $('confirm-quote').disabled=state.busy || paymentLocksWorkspace() || !$('confirm-scope').checked || !$('confirm-price').checked;
}
function paymentLocksWorkspace() { return Boolean(state.payment || state.paymentUncertain); }
function adoptPayment(data) {
  const previousId=state.payment?.id;
  state.payment=data.payment || null;
  state.paymentUncertain=Boolean(state.payment && !validPayment(state.payment));
  state.paymentError=state.paymentUncertain ? 'paymentInvalid':null;
  if (state.payment?.id!==previousId) state.paymentReconciledId=null;
  state.sandboxConsent=false;
}
function paymentActionButton(id,key,action) {
  const button=translated('button',key,{id,type:'button',class:'button secondary',disabled:state.busy || state.needsSync || !state.ready});
  button.addEventListener('click',action);return button;
}
function renderPayment() {
  const root=$('payment-stage');if (!root) return;
  root.replaceChildren();
  root.setAttribute('aria-label',t('sandboxSteps'));
  const display=paymentDisplay();
  $('quote-payment-badge').textContent=t(({not_started:'notPaid',in_progress:'sandboxInProgress',unverified:'sandboxUnverified',verified:'sandboxCaptured'})[display]);
  $('quote-payment-badge').dataset.status=display;
  if (!state.ready || (state.capabilities.paypal!==true && !paymentLocksWorkspace())) {
    root.className='payment-boundary';
    root.append(el('span',{class:'boundary-icon','aria-hidden':'true',text:'∅'}),el('div',{},translated('strong','paypalPending'),translated('p','noPayment')));return;
  }
  root.className='payment-panel';
  root.append(el('div',{class:'payment-heading'},translated('span','sandboxEyebrow',{class:'eyebrow'}),translated('h4','sandboxHeading')),translated('p','sandboxBoundary',{class:'payment-disclaimer'}));
  const payment=state.payment, valid=validPayment(payment), current=isCurrentQuote(state);
  const done=display==='verified';
  const approved=valid && payment.providerOrderStatus==='APPROVED';
  const steps=el('ol',{class:'payment-steps','aria-label':t('sandboxSteps')});
  const marks=[current || valid,approved || done,valid && approved && state.paymentReconciledId===payment.id || done,done];
  ['sandboxStepQuote','sandboxStepApproval','sandboxStepVerify','sandboxStepReceipt'].forEach((key,index)=>steps.append(el('li',{'data-complete':String(Boolean(marks[index]))},el('span',{class:'payment-step-number','aria-hidden':'true',text:String(index+1)}),el('span',{text:t(key)}),el('span',{class:'sr-only',text:t(marks[index] ? 'stepComplete':'stepWaiting')}))));
  root.append(steps);
  if (paymentLocksWorkspace()) root.append(translated('p',done ? 'paymentCompletedLock':'paymentLocked',{class:'payment-lock'}));
  if (state.paymentUncertain) {root.append(translated('p',state.paymentError || 'paymentRequestFailed',{class:'payment-status','role':'status'}),translated('p','paymentRefreshRequired',{class:'microcopy'}));return;}
  if (payment && (state.needsSync || !paymentMatchesQuote(payment,state.quote))) {root.append(translated('p','paymentUnverified',{class:'payment-status','role':'status'}),translated('p','paymentRefreshRequired',{class:'microcopy'}));return;}
  if (!payment) {
    if (!current) {root.append(translated('p','sandboxNeedsQuote',{class:'microcopy'}));return;}
    if (state.capabilities.paypal!==true) {root.append(translated('p','paypalPending'));return;}
    root.append(el('p',{class:'payment-fixed-total',text:t('sandboxFixedTotal',{amount:money(state.quote.totalCents,state.quote.currency)})}));
    const consent=el('input',{id:'sandbox-consent',type:'checkbox',checked:state.sandboxConsent,disabled:state.busy || state.needsSync});
    consent.addEventListener('change',()=>{state.sandboxConsent=consent.checked;$('create-sandbox-payment').disabled=!state.sandboxConsent || state.busy || state.needsSync;});
    root.append(el('label',{class:'check-row'},consent,translated('span','sandboxConsent')));
    const create=paymentActionButton('create-sandbox-payment','sandboxCreate',()=>runPaymentAction('create'));
    create.disabled=create.disabled || !state.sandboxConsent;
    root.append(create);return;
  }
  if (!valid) return;
  root.append(el('p',{class:'payment-fixed-total',text:t('sandboxFixedTotal',{amount:money(paymentAmountCents(payment),'USD')})}));
  if (!paymentMatchesQuote(payment,state.quote)) root.append(translated('p','paymentPinnedQuote',{class:'microcopy'}));
  const statusKey=done ? 'paymentCompleted':payment.state==='unknown' ? 'paymentUnknown':payment.state==='capture_pending' ? 'paymentPending':payment.state==='creating' ? 'paymentCreating':approved ? 'paymentApproved':'paymentAwaitingApproval';
  root.append(translated('p',statusKey,{class:'payment-status','role':'status'}));
  if (payment.lastIssue) root.append(translated('p',payment.lastIssue==='provider_pending' ? 'paymentProviderPending':'paymentUnverified',{class:'microcopy'}));
  if (state.paymentError) root.append(translated('p',state.paymentError,{class:'payment-error','role':'alert'}));
  const refs=el('dl',{class:'payment-references'});
  for (const [key,value] of [['quoteReference',payment.quoteId],['paymentReference',payment.id],['sandboxOrderReference',payment.orderId],['sandboxCaptureReference',done ? payment.captureId:null]]) if (value) refs.append(el('div',{},translated('dt',key),el('dd',{text:value})));
  root.append(refs);
  if (done) {root.append(translated('p','paymentReceiptLimit',{class:'microcopy'}));return;}
  if (state.capabilities.paypal!==true) {root.append(translated('p','paymentUnavailable',{class:'microcopy'}));return;}
  const actions=el('div',{class:'payment-actions'}), approvalUrl=sandboxApprovalUrl(payment);
  if (approvalUrl && !approved && !state.busy && !state.needsSync) actions.append(translated('a','sandboxApprove',{id:'sandbox-approval-link',class:'button primary',href:approvalUrl,target:'_blank',rel:'noopener noreferrer'}));
  if (payment.orderId) actions.append(paymentActionButton('reconcile-sandbox-payment','sandboxReconcile',()=>runPaymentAction('reconcile')));
  if (canCapturePayment(payment,state.paymentReconciledId)) actions.append(paymentActionButton('capture-sandbox-payment','sandboxCapture',()=>runPaymentAction('capture')));
  root.append(actions,translated('p',!payment.orderId ? 'paymentManualRecovery':'paymentReturnHint',{class:'microcopy'}));
}
async function runPaymentAction(action) {
  if (state.busy || state.needsSync || !state.ready || state.paymentUncertain || state.capabilities.paypal!==true) return;
  if (action==='create' && (state.payment || !state.sandboxConsent || !isCurrentQuote(state))) return;
  if (action!=='create' && (!validPayment(state.payment) || state.payment.state==='completed' || !state.payment.orderId)) return;
  if (action==='capture' && !canCapturePayment(state.payment,state.paymentReconciledId)) return;
  const paymentId=state.payment?.id;
  const path=action==='create' ? '/api/payments/create':`/api/payments/${encodeURIComponent(paymentId)}/${action}`;
  const body=action==='create' ? {quoteId:state.quote.id}:{};
  const op=beginOperation('payment');state.paymentError=null;notify('paymentStatus','busy');
  try {
    const data=await request(path,{method:'POST',body,timeout:45000});
    if (!operations.current(op)) return;
    if (!validPayment(data.payment) || (paymentId && data.payment.id!==paymentId) || (action==='create' && !paymentMatchesQuote(data.payment,state.quote))) throw new ApiError('invalid_payment',t('paymentInvalid'));
    state.payment=data.payment;state.sandboxConsent=false;
    state.paymentReconciledId=action==='reconcile' ? data.payment.id:null;
    notify('paymentStatus',paymentDisplay()==='verified' ? 'success':paymentDisplay()==='unverified' ? 'error':'info');
  } catch(error) {
    if (!operations.current(op)) return;
    // A transport error never proves that create/capture did not reach the provider.
    // Only a fresh server snapshot may unlock this workspace or enable another action.
    state.paymentUncertain=true;state.sandboxConsent=false;state.paymentReconciledId=null;
    state.paymentError=error.code==='invalid_payment' ? 'paymentInvalid':error.code==='paypal_disabled' ? 'paymentUnavailable':'paymentRequestFailed';
    notify('paymentStatus','error');
  } finally {finishOperation(op);}
}
function updateDerived() {
  $('brief-count').textContent=`${$('raw-brief').value.length.toLocaleString(getLanguage())} / 2,000`;
  updateActivity();
  renderPayment();
  refreshNotice();
  const badge=$('draft-state');
  if (!state.draft) {badge.textContent=t('waiting');badge.dataset.state='empty';return;}
  const key=state.needsSync ? 'syncNeededState':state.dirty ? 'dirtyState':isCurrentQuote(state) ? ({not_started:'quotedState',in_progress:'sandboxInProgress',unverified:'sandboxUnverified',verified:'sandboxCaptured'})[paymentDisplay()]:state.draft.review ? 'reviewedState':'draftState';
  badge.textContent=t(key);badge.dataset.state=state.dirty?'dirty':state.draft.state;
  $('attribution-meta').textContent=t(state.extraction?.mode==='manual'?'mode_manual':'mode_ai');
  const originalSku=state.draft.requestedRequirements.find(item=>item.field==='sku');
  $('original-comparison').textContent=t(!originalSku ? 'originalMissing':!findOffer(originalSku.value) ? 'originalUnsupported':'originalCompared');
  if (state.draft.review) $('conflict-heading').textContent=t('historicalFlags');
  const ready=reviewReadiness();renderComparison(ready);
  $('save-review').disabled=!state.ready || state.needsSync || state.busy || paymentLocksWorkspace() || !ready.complete;
  $('catalog-values').disabled=state.needsSync || state.busy || paymentLocksWorkspace() || !ready.comparison.offer;
  $('review-progress').textContent=ready.mismatch ? t('acceptMismatch'):ready.missing.length || ready.pendingDecisions || ready.pendingResolutions ? t('progress',{fields:ready.missing.length,decisions:ready.pendingDecisions,conflicts:ready.pendingResolutions}):!$('confirm-grounding').checked || !$('confirm-rights').checked ? t('confirmationsNeeded'):t('reviewReady');
  renderQuote();
}
function markDirty() {
  if (!state.draft || paymentLocksWorkspace()) return;
  state.dirty=true;state.quote=null;
  $('confirm-grounding').checked=false;$('confirm-rights').checked=false;
  $('confirm-scope').checked=false;$('confirm-price').checked=false;
  updateDerived();
}
function validateBootstrap(data) {
  if (typeof data.csrf!=='string' || !Array.isArray(data.catalog) || !Array.isArray(data.systemRestrictions)) throw new ApiError('invalid_session',t('sessionError'));
}
function adoptBootstrap(data,{preserveBrief=false}={}) {
  validateBootstrap(data);
  const brief=$('raw-brief').value;
  state.csrf=data.csrf;state.catalog=data.catalog;state.catalogVersion=data.catalogVersion;state.restrictions=data.systemRestrictions;
  state.capabilities=data.capabilities || {};state.activity=data.activity || {};state.draft=data.draft;state.quote=data.quote;state.extraction=data.extraction || null;state.ready=true;state.needsSync=false;
  adoptPayment(data);
  if (!state.draft) { $('raw-brief').value=preserveBrief ? brief:'';$('sample-label').hidden=!$('raw-brief').value.startsWith('[CLEARED SYNTHETIC SAMPLE');state.dirty=false; }
  renderCatalog();renderDraft();
}
function synchronizeBootstrap(data) {
  validateBootstrap(data);
  if (!sameReviewContext(state,data)) {adoptBootstrap(data,{preserveBrief:true});return;}
  const targetChanged=!sameQuoteTarget(state,data);
  state.csrf=data.csrf;state.catalog=data.catalog;state.restrictions=data.systemRestrictions;
  state.draft=data.draft;state.quote=data.quote;state.capabilities=data.capabilities || {};
  state.activity=data.activity || {};state.extraction=data.extraction || null;state.ready=true;state.needsSync=false;
  adoptPayment(data);
  if (targetChanged) {$('confirm-scope').checked=false;$('confirm-price').checked=false;}
  // Do not replace review DOM: unsaved scope, notes and review assertions still belong to this context.
  renderCatalog();updateDerived();
}
async function createDraft(mode) {
  if (state.busy || state.needsSync || !state.ready || state.draft || paymentLocksWorkspace()) return;
  const rawBrief=$('raw-brief').value; if (!rawBrief.trim() || rawBrief.length>2000) return;
  if (mode==='ai' && (!state.capabilities.localAi || state.activity.aiBusy)) {notify('aiUnavailable');return;}
  const op=beginOperation(mode==='ai'?'ai':'manual');notify(mode==='ai'?'extracting':'creatingManual','busy');
  try {
    const data=await request('/api/drafts',{method:'POST',body:{rawBrief,mode},timeout:mode==='ai'?100000:20000});
    if (!operations.current(op)) return;
    state.draft=data.draft;state.quote=null;state.extraction=data.extraction || {mode};state.activity=data.activity || {};
    renderDraft();notify('draftCreated','success');$('review-heading').scrollIntoView({block:'start'});
  } catch(error) {if (!operations.current(op)) return;if (mode==='ai' && error.code==='timeout') state.activity.aiBusy=true;showError(error);}
  finally {finishOperation(op);}
}
$('brief-form').addEventListener('submit',event=>{event.preventDefault();createDraft('ai');});
$('manual-button').addEventListener('click',()=>createDraft('manual'));
$('raw-brief').addEventListener('input',()=>{$('sample-label').hidden=!$('raw-brief').value.startsWith('[CLEARED SYNTHETIC SAMPLE');updateDerived();});
$('sample-button').addEventListener('click',()=>{if (state.draft || state.busy || paymentLocksWorkspace()) return;$('raw-brief').value=sample;$('sample-label').hidden=false;updateDerived();$('raw-brief').focus();});
$('review-form').addEventListener('input',event=>{if (!['confirm-grounding','confirm-rights'].includes(event.target.id)) markDirty();else updateDerived();});
$('review-form').addEventListener('change',event=>{if (!['confirm-grounding','confirm-rights'].includes(event.target.id)) markDirty();else updateDerived();});
$('catalog-values').addEventListener('click',()=>{
  const offer=findOffer(controls.get('sku')?.input.value);if (!offer || state.busy || state.needsSync || paymentLocksWorkspace()) return;
  const values={deliverables:offer.maxDeliverables,secondsPerDeliverable:offer.maxSeconds,captionsLanguage:offer.captionsLanguage,aspectRatio:offer.aspectRatio,revisions:offer.maxRevisions,deliveryDays:offer.minDeliveryDays,deliveryStarts:'source_receipt'};
  for (const [field,value] of Object.entries(values)) setControl(controls.get(field),value);
  markDirty();
});
$('review-form').addEventListener('submit',async event=>{
  event.preventDefault();if (state.busy || state.needsSync || !state.ready || !state.draft || paymentLocksWorkspace()) return;const ready=reviewReadiness();
  if (!ready.complete) {notify('invalidInput','error');return;}
  const draft=state.draft;
  const body={expectedVersion:draft.version,scope:ready.scope,decisions:ready.decisionPayload,resolutions:ready.resolutionPayload,confirmSourceGrounding:true,confirmRights:true};
  const op=beginOperation('review');notify('saving','busy');
  try {const data=await request(`/api/drafts/${encodeURIComponent(draft.id)}/review`,{method:'POST',body});if (!operations.current(op)) return;state.draft=data.draft;state.quote=null;renderDraft();notify('saved','success');$('quote-stage').scrollIntoView({block:'start'});}
  catch(error){if (operations.current(op)) showError(error);}finally{finishOperation(op);}
});
$('quote-form').addEventListener('change',()=>renderQuote());
$('quote-form').addEventListener('submit',async event=>{
  event.preventDefault();const draft=state.draft,review=draft?.review,offer=review ? findOffer(review.scope.sku):null;
  if (state.busy || state.needsSync || !state.ready || state.dirty || paymentLocksWorkspace() || !review || !offer || !$('confirm-scope').checked || !$('confirm-price').checked) return;
  const body={expectedVersion:draft.version,reviewDigest:review.digest,confirmScope:true,acceptCatalogPrice:true,expectedTotalCents:offer.priceCents};
  const op=beginOperation('quote');notify('confirming','busy');
  try {const data=await request(`/api/drafts/${encodeURIComponent(draft.id)}/quote`,{method:'POST',body});if (!operations.current(op)) return;state.quote=data.quote;state.draft={...state.draft,state:'confirmed_quote',quoteId:data.quote.id};notify('confirmedQuote','success');}
  catch(error){if (operations.current(op)) showError(error);}finally{finishOperation(op);}
});
$('clear-button').addEventListener('click',()=>{if (canClear()) $('clear-dialog').showModal();});
$('cancel-clear').addEventListener('click',()=>$('clear-dialog').close());
$('clear-dialog').addEventListener('cancel',event=>{if (operations.kind==='clear') event.preventDefault();});
$('confirm-clear').addEventListener('click',async()=>{
  if (!canClear()) return;
  const op=beginOperation('clear',{supersede:true});notify('clearing','busy');
  try {
    const data=await request('/api/clear',{method:'POST',body:{}});
    if (!operations.current(op)) return;
    adoptBootstrap(data);$('clear-dialog').close();notify('cleared','success');$('raw-brief').focus();
  } catch {
    if (!operations.current(op)) return;
    state.needsSync=true;updateDerived();
    try {
      // A lost Clear response cannot establish whether the server revoked the workspace.
      const data=await request('/api/session');
      if (!operations.current(op)) return;
      synchronizeBootstrap(data);notify('clearReconciled','info');
    } catch {
      if (!operations.current(op)) return;
      state.needsSync=true;notify('clearUncertain','error');
    }
    $('clear-dialog').close();
  } finally {finishOperation(op);}
});
$('refresh-session').addEventListener('click',async()=>{
  if (state.busy) return;const op=beginOperation('refresh');
  try {
    const data=await request('/api/session');
    if (!operations.current(op)) return;
    synchronizeBootstrap(data);
    notify('statusRefreshed','success');
  } catch(error){if (operations.current(op)) showError(error);}finally{finishOperation(op);}
});
$('language').addEventListener('change',event=>{
  setLanguage(event.target.value);renderCatalog();
  for (const input of document.querySelectorAll('[data-label-field]')) input.setAttribute('aria-label',t(input.dataset.labelField));
  for (const node of document.querySelectorAll('[data-offer-sku]')) {const offer=findOffer(node.dataset.offerSku);if (offer) node.textContent=offerName(offer);}
  refreshNotice();updateDerived();
});
applyTranslations();updateDerived();notify('connecting','busy');
const startup=beginOperation('connect');
try {const data=await request('/api/session');if (operations.current(startup)) {adoptBootstrap(data);notify('connected','success');}}
catch(error){if (operations.current(startup)) {state.ready=false;notify('sessionError','error',error.code ? `[${error.code}]`:'');}}
finally {finishOperation(startup);}
