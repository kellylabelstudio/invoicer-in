import { amount, checkTemplate, clone, csvRegister, defaultTemplate, displayDate, documentPages, escapeHtml as e,
  freightTemplate, makePdf, paymentQrPayload, qrPayload, resizePaper, templateSections, toSvg, validLogo } from './document.mjs';
import { freightColumns } from './freight.mjs';
import { accentColor, accentPresets, appearanceMode, appearanceModes, displayReady, interfaceSize, interfaceSizeLabel, interfaceSizes, paintColorControls, paintDisplayControls, resetAccentColor, setAccentColor, setAppearance, setInterfaceSize, visualMode, setVisualMode, density, setDensity } from './appearance.mjs';
import { gstStates } from './gst-states.mjs';

const root = document.querySelector('#app');
const toastNode = document.querySelector('#toast');
const modal = document.querySelector('#modal');
const invoke = (command, args = {}) => globalThis.__TAURI__.core.invoke(command,args);
const state = {
  view:'invoices', panel:'form', settings:{seller:{},irp:'review',driveAuto:false}, drive:{}, invoices:[], customers:[],
  filter:'', customerFilter:'', draft:null, customer:null, fromDraft:false, selected:'items', layout:null,
  page:0, zoom:false, latestPreview:0, locked:false, note:'', editorTab:'details',
  services:[], service:null, serviceFilter:'', draftServiceFilter:'', serviceFromDraft:false, payments:[], paymentInvoice:'', paymentForm:null,
  info:{}, fieldErrors:{}, issueError:'', draftRevision:0, draftSaveStatus:'saved', savedAt:null,
  splitView:localStorage.getItem('invoicer-preview-mode')!=='form', layoutUndo:[], layoutRedo:[], snap:false, layoutZoom:false
};
const emptyAmounts = () => ({lines:[],totals:{taxable:0,cgst:0,sgst:0,igst:0,cess:0,total:0}});
const emptyLine = () => ({description:'',hsn:'',quantity:'1',unit:'NOS',unitPrice:'',discount:'',gstRate:'',cessRate:''});
const partyFields = [['name','Name'],['address','Address'],['address2','Address line 2'],['pan','PAN'],['gstin','GSTIN'],['state','State or UT'],['stateCode','State code'],['email','Email'],['phone','Phone']];
const text = (value) => String(value ?? '');
const search = (filter, values) => values.some(value => text(value).toLowerCase().includes(filter.trim().toLowerCase()));
const icon = name => `<svg class="ico" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
const btn = (action,label,classes='',attrs='',glyph='') =>
  `<button type="button" data-action="${action}" class="${classes}" ${attrs}>${glyph ? icon(glyph) : ''}${e(label)}</button>`;
const toggle = (name,label,value) => `<label class="toggle"><input type="checkbox" name="${name}" ${value?'checked':''}><span>${e(label)}</span></label>`;
const field = (name,label,value='',type='text',attrs='') => `<label class="field ${type==='textarea'?'full':''}"><span>${e(label)}</span>${
  type==='textarea' ? `<textarea aria-label="${e(label)}" name="${name}" maxlength="5000" ${attrs} aria-invalid="${Boolean(state.fieldErrors[name])}">${e(value)}</textarea>` :
    `<input aria-label="${e(label)}" type="${type}" name="${name}" value="${e(value)}" ${attrs} aria-invalid="${Boolean(state.fieldErrors[name])}">`}${state.fieldErrors[name]?`<small class="field-error" role="alert">${e(state.fieldErrors[name])}</small>`:''}</label>`;
const select = (name,label,value,options) => `<label class="field"><span>${e(label)}</span><select aria-label="${e(label)}" name="${name}" aria-invalid="${Boolean(state.fieldErrors[name])}">${options
  .map(([key, title])=>`<option value="${e(key)}" ${value===key?'selected':''}>${e(title)}</option>`).join('')}</select>${state.fieldErrors[name]?`<small class="field-error" role="alert">${e(state.fieldErrors[name])}</small>`:''}</label>`;
const section = (title,body,actions='',id='') => `<section class="card card-pad" ${id?`id="${id}"`:''}><div class="cardhead"><h2>${title}</h2><div class="actions">${actions}</div></div>${body}</section>`;
const searchBox = (name, value, placeholder) => `<label class="search">${icon('search')}<input type="search" name="${name}" aria-label="${e(placeholder)}" placeholder="${e(placeholder)}" value="${e(value)}"></label>`;
const setByPath = (target, path, value) => {
  const names = path.split('.');
  for (const name of names.slice(0,-1)) target = target[name] ??= {};
  target[names.at(-1)] = value;
};
function notify(message, error=false) {
  toastNode.textContent = text(message);
  toastNode.classList.toggle('error',error);
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => { toastNode.textContent=''; }, error?11000:4700);
}
function confirm(title, content, label='Continue') {
  modal.querySelector('h2').textContent=title;
  modal.querySelector('p').textContent=content;
  modal.querySelector('[value=confirm]').textContent=label;
  modal.returnValue='cancel';
  modal.showModal();
  return new Promise(resolve => modal.addEventListener('close',() => resolve(modal.returnValue==='confirm'),{once:true}));
}
function today() {
  const now = new Date();
  return [now.getFullYear(),String(now.getMonth()+1).padStart(2,'0'),String(now.getDate()).padStart(2,'0')].join('-');
}
function activeTemplate() { return state.settings.template ?? freightTemplate; }
const paymentFields = [['holder','Account holder'],['bank','Bank name'],['account','Account number'],['ifsc','IFSC'],['branch','Branch (optional)']];
function invoiceSnapshot() {
  const d={...clone(state.draft),seller:clone(state.settings.seller)};
  d.printDate=today();delete d.payment;
  if(d.includePayment) d.payment={...clone(state.settings.payment??{}),method:d.paymentMethod??'bank'};
  return d;
}
function rememberLayout(previous = state.layout) {
  state.layoutUndo.push(clone(previous));
  if(state.layoutUndo.length>35)state.layoutUndo.shift();
  state.layoutRedo=[];
}
function loadLayout(template) {
  rememberLayout();
  state.layout=clone(template);
  if(!state.layout.blocks[state.selected]) state.selected='items';
  render();
}
function heading(title,subtitle,actions='',eyebrow='Workspace') {
  return `<header class="pagehead"><div><span class="eyebrow">${eyebrow}</span><h1>${title}</h1><p>${subtitle}</p></div><div class="actions">${actions}</div></header>`;
}
function panelTitle() {
  return {invoices:'Invoices',draft:'Invoice editor',customers:'Customers',contact:'Customer details',layout:'Layout editor',settings:'Settings',services:'Services',service:'Service details',payments:'Payments',help:'Help & about'}[state.view];
}
function appearanceControls(compact=false) {
  return `<div class="theme-switch ${compact?'compact':''}" role="group" aria-label="Appearance">${appearanceModes.map(([mode,label,glyph])=>
    `<button type="button" data-action="appearance" data-appearance="${mode}" aria-label="${label}" title="${label}" aria-pressed="${mode===appearanceMode()}">${icon(glyph)}${compact?'':`<span>${label}</span>`}</button>`).join('')}</div>`;
}
function accentControls(theme) {
  const name=theme==='light'?'Light':'Dark';
  return `<section class="accent-card"><div class="accent-title">${icon(theme==='light'?'sun':'moon')}<h3>${name} mode accent</h3>${btn('accent-reset','Reset','subtle',`data-id="${theme}" aria-label="Reset ${name.toLowerCase()} accent"`)}</div>
    <div class="accent-preview ${theme}" data-accent-preview="${theme}"><span class="mini-invoice">${icon('invoice')}</span><span><strong>Invoice workspace</strong><small>${name} theme preview</small></span><span class="mini-action">New invoice</span></div>
    <div class="accent-swatches" role="group" aria-label="${name} accent presets">${accentPresets.map(([label,light,dark])=>{
      const color=theme==='light'?light:dark;
      return `<button type="button" data-action="accent-preset" data-theme="${theme}" data-accent-preset="${color}" aria-label="${name} ${label.toLowerCase()} accent" title="${label}" aria-pressed="${accentColor(theme)===color}" style="--swatch:${color}">${icon('check')}</button>`;
    }).join('')}</div>
    <div class="custom-color"><label class="color-picker"><input type="color" data-accent-control="${theme}" name="accentColor.${theme}" aria-label="${name} accent color" value="${accentColor(theme)}"><span>Custom color</span></label><label class="field"><span>Hex</span><input type="text" data-accent-control="${theme}" name="accentHex.${theme}" aria-label="${name} accent hex" value="${accentColor(theme)}" maxlength="7" spellcheck="false" autocomplete="off"></label></div></section>`;
}
function frame(content) {
  const nav = [['invoices','Invoices','invoice'],['customers','Customers','people'],['services','Services','box'],['layout','Layout editor','layout'],['settings','Settings','settings'],['help','Help & about','help']];
    return `<div class="ambient" aria-hidden="true"><span class="ambient-one"></span><span class="ambient-two"></span><span class="ambient-ring"></span></div><div class="shell" data-view="${state.view}"><aside class="sidebar"><div class="brand"><div class="brand-mark">${icon('invoice')}</div>
    <div class="brand-text"><strong>Invoicer In</strong><span>Kelly Label Studio</span></div></div>
    ${btn('new','Create invoice','primary sidebar-create','','plus')}
    <div class="nav-caption">Workspace</div><nav class="nav" aria-label="Workspace">${nav.map(([id,title,glyph]) => {
      const active = state.view===id || id==='invoices'&&['draft','payments'].includes(state.view) || id==='customers'&&state.view==='contact' || id==='services'&&state.view==='service';
      return `<button type="button" data-action="nav" data-id="${id}" title="${title}" aria-label="${title}" ${active?'aria-current="page"':''}>${icon(glyph)}<span class="label">${title}</span></button>`;
    }).join('')}</nav>
    <div class="sidebar-footer">${icon('lock')}<span><strong>India GST workspace</strong><small>Records stored on this PC</small></span></div></aside>
    <main class="workspace"><div class="topbar">
      <div class="crumb"><span>${e(state.settings.seller?.name||'Your business')}</span>${icon('chevron')}<strong>${panelTitle()}</strong></div>
      <div class="topbar-actions"><button type="button" class="glass-toggle" data-action="toggle-glass" data-glass-toggle aria-label="Glass appearance" aria-pressed="${visualMode()==='beautiful'}">${icon('sparkles')}<span data-glass-label>${visualMode()==='beautiful'?'Glass':'Performance'}</span></button><button type="button" class="display-size-button" data-action="display-settings" title="Change interface size in Settings" aria-label="Interface size settings">${icon('monitor')}<span data-display-size>${interfaceSizeLabel()}</span></button><span class="pill workspace-status">${icon(state.drive.connected?'cloud':'lock')}${state.drive.connected?'Drive connected':'Local workspace'}</span>
        ${appearanceControls(true)}</div>
      </div>${content}</main></div>`;
}
function invoiceRows() {
  const rows = state.invoices.filter(row=>search(state.filter,[row.number,row.buyer,row.day,row.driveStatus,row.paymentStatus]));
  if (!rows.length) return `<div class="empty">${icon('invoice')}<h2>${state.filter?'No matching invoices':'No invoices yet'}</h2>
    <p>${state.filter?'Try an invoice number, customer or date.':'Create a tax invoice or import records from the Python app.'}</p>${
      state.filter?'':btn('new','New invoice','primary','','plus')}</div>`;
  return `<div class="table-wrap"><table><thead><tr><th>Invoice</th><th>Customer</th><th>Date</th><th class="money">Total</th><th>Status</th><th>Drive</th><th>Actions</th></tr></thead><tbody>${rows.map(r=> {
    const attr=`data-id="${e(r.id)}"`;
    const status = r.driveStatus;
    const tag = !status ? '—' : `<span title="${e(r.driveMessage)}" class="tag ${status==='Uploaded'?'ok':status==='Failed'?'error':'warn'}">${e(status)}</span>`;
    return `<tr><td><strong>${e(r.number)}</strong> ${r.legacy?'<span class="tag">Imported</span>':''}</td><td>${e(r.buyer)||'—'}</td>
      <td>${e(displayDate(r.day))}</td><td class="money">${amount(r.total)}<br><small>${amount(r.balance??r.total)} outstanding</small></td><td><span class="tag ${r.paymentStatus==='Paid'?'ok':r.paymentStatus==='Overdue'?'error':''}">${e(r.paymentStatus??'Issued')}</span></td><td>${tag}</td>
      <td><div class="actions">${btn('payments','Payments','',attr)}${r.hasPdf?btn('export','PDF','',attr):''}${btn('duplicate','Duplicate','subtle',attr)}
        ${status==='Uploaded'?btn('copy-link','Drive link','subtle',attr)+btn('share-link','Share','subtle',attr):''}
        ${['Failed','Retrying','Paused'].includes(status)?btn('retry','Retry','subtle',attr):''}</div></td></tr>`;
  }).join('')}</tbody></table></div>`;
}
function invoicesView() {
  const total = state.invoices.reduce((sum,r)=>sum+r.total,0);
  const queued = state.invoices.filter(r=>['Queued','Uploading','Retrying'].includes(r.driveStatus)).length;
  const metrics = [
    ['invoice','Invoices issued',state.invoices.length,'All invoices in your register'],
    ['coins','Outstanding',amount(state.invoices.reduce((sum,r)=>sum+(r.balance??r.total),0)),'Awaiting payment'],
    ['coins','Total invoiced',amount(total),'Across issued invoices'],
    ['people','Saved customers',state.customers.length,'Ready to reuse on a new invoice']
  ];
  return heading('Invoices','Create GST invoices and find every invoice you’ve issued.',
    btn('new',state.draft?'Open draft':'New invoice','primary','','plus'),'India · GST workspace')+
    `${setupChecklist()}<div class="stats">${metrics.map(([glyph,label,value,caption],index)=>
      `<section class="card stat ${index===0?'stat-featured':''}"><div class="stat-head"><span class="stat-icon">${icon(glyph)}</span><span class="k">${label}</span></div>
        <strong>${value}</strong><p>${caption}</p></section>`).join('')}</div>
    <div class="workspace-shortcuts"><span>Ready when you are</span><div class="actions">${btn('nav','Customer book','subtle','data-id="customers"','people')}${btn('nav','Saved services','subtle','data-id="services"','box')}${btn('nav','Invoice design','subtle','data-id="layout"','layout')}</div></div>
    <section class="card register-card"><div class="register-head"><div><h2>Invoice register <span class="register-count">${state.invoices.length}</span></h2><p class="muted">Your invoices, payment progress and PDFs in one place.</p></div>
      ${queued?`<span class="tag warn">${icon('cloud')}${queued} awaiting upload</span>`:''}</div>
      <div class="listbar">${searchBox('invoiceSearch',state.filter,'Search by invoice or customer')}
      <div class="actions">${btn('register','Export CSV') }${btn('import','Import from Python','subtle')}</div></div>
      <div id="invoice-rows">${invoiceRows()}</div></section>`;
}
function placeOfSupply(draft) {
  const code = draft.placeOfSupplyCode ?? '';
  const options = [['','Select state or union territory'], ...[...gstStates].map(([id,name])=>[id,`${name} · ${id}`])];
  if(code && !gstStates.has(code)) options.push([code, `${draft.placeOfSupply || 'Saved place of supply'} · ${code}`]);
  return select('placeOfSupplyCode','Place of supply',code,options);
}
function partyGrid(prefix,data={}) {
  return `<div class="grid">${partyFields.map(([key,label]) => field(`${prefix}.${key}`,label,data[key],key==='address'?'textarea':key==='email'?'email':key==='phone'?'tel':'text',key==='stateCode'?'maxlength="2" inputmode="numeric"':'maxlength="250"')).join('')}</div>`;
}
function lines(d) {
  const columns = [['code','Item code'],['description','Description','double'],['hsn','HSN / SAC','double'],['quantity','Quantity'],['unit','Unit / UQC'],
    ['unitPrice','Unit price (₹)'],['discount','Discount (₹)'],['gstRate','GST %'],['cessRate','Cess %']];
  return `<div class="items">${d.items.map((item,index)=>`<article class="item"><div class="item-head"><h3>Item ${index+1}</h3>
    ${btn('save-line-service','Save to catalogue','subtle',`data-id="${index}"`)}${btn('remove-item','Remove','subtle danger',`data-id="${index}" ${d.items.length===1?'disabled':''}`)}</div>
    <div class="grid">${columns.map(([key,label,cls])=>`<div class="${cls??''}">${field(`items.${index}.${key}`,label,item[key],'text',
      ['code','description','hsn','unit'].includes(key)?'maxlength="220"':'inputmode="decimal" maxlength="18"')}</div>`).join('')}</div></article>`).join('')}</div>`;
}
function draftView() {
  const d=state.draft;
  const customerOptions = [['','Choose a saved customer'],...state.customers.filter(c=>search(state.draftSearch??'',[c.name,c.billing?.gstin,c.email,c.phone]))
    .map(c=>[c.id,`${c.name}${c.billing?.gstin?' · '+c.billing.gstin:''}`])];
  const shipmentFields = [['order','Order no.'],['orderDate','Order date'],['journey','Journey no.'],['origin','From'],['destination','To'],['container','Container no.'],
    ['containerSize','Container size (FT)'],['containerType','Container type'],['containerStatus','Container status (L/E)']];
  const buyerActions=btn('from-draft','Save as customer','subtle');
  const previewBtn=(id,label)=>btn('panel',label,'',`data-id="${id}" aria-pressed="${state.panel===id}"`);
  const editorTabs=[['details','Details'],['customer','Customer'],['items','Line items'],['notes','Notes']];
  const tabs=editorTabs.map(([key,label])=>btn('editor-tab',label,'subtle',`data-id="${key}" aria-pressed="${state.editorTab===key}"`)).join('');
  const hide=key=>state.editorTab===key?'':'hidden';
  return heading('Invoice editor','Add your invoice details, choose a customer and review the PDF.','',`Draft · ${e(d.number)}`)+
    `${state.issueError?`<p class="notice error" role="alert">${e(state.issueError)}</p>`:''}<div class="editor-command"><div class="segment" aria-label="Editor view">${previewBtn('form','Form')}${previewBtn('preview','Preview')}</div>
      <div class="actions">${state.panel==='form'?btn('preview-mode',state.splitView?'Hide live preview':'Show live preview','preview-mode','','layout'):''}${`<span id="draft-save-status" class="save-status" role="status">${draftStatusText()}</span>`+btn('save-draft','Save draft','','','save')}${btn('discard','Discard draft','subtle danger')}${btn('issue','Issue invoice','primary',state.locked?'disabled':'','save')}</div></div>
    <div class="editor" data-panel="${state.panel}" data-preview="${state.splitView?'split':'form'}"><div class="pane form panel-list" id="draft-form">
    <nav class="editor-tabs" aria-label="Invoice sections">${tabs}</nav><div class="panel-list" ${hide('details')}>
    ${!state.settings.seller?.gstin?`<p class="notice">Set up your supplier GSTIN and address in Settings before issuing your first invoice.</p>`:''}
    ${section('Invoice details',`<div class="grid">${field('number','Invoice number',d.number,'text','maxlength="16"')+field('date','Invoice date',d.date,'date')+
      field('dueDate','Payment due date (optional)',d.dueDate,'date')+placeOfSupply(d)+
      select('regime','India GST treatment',d.regime,[['split','CGST + SGST'],['utgst','CGST + UTGST'],['igst','IGST']])+
      toggle('reverseCharge','Reverse charge applies',d.reverseCharge)}</div>`,btn('next-number','Get next number','subtle'))}
    ${section('Shipment details',`<div class="grid">${shipmentFields.map(([key,label])=>field(key,label,d[key],key==='orderDate'?'date':'text')).join('')}</div>`)}
    </div><div class="panel-list" ${hide('customer')}>
    ${section('Buyer',`<div class="customer-lookup"><div class="grid">${searchBox('draftCustomerSearch',state.draftSearch??'','Find by name or GSTIN')}
      ${btn('apply-customer','Use customer','subtle')}</div><div id="draft-customer-list">${select('customerId','Saved customer',d.customerId,customerOptions)}</div></div>
      ${partyGrid('buyer',d.buyer)}`,buyerActions)}
    ${section('Shipping / dispatch',partyGrid('ship',d.ship),btn('same-address','Copy billing address','subtle'))}
    </div><div class="panel-list" ${hide('items')}>
    ${section('Line items',servicePicker()+lines(d),btn('add-item','Add line','','','plus'))}</div><div class="panel-list" ${hide('notes')}>
    ${section('Notes and payment',`<div class="grid">${field('paymentTerms','Payment terms',d.paymentTerms)+field('insurance','Insurance by',d.insurance)+
      field('transactionType','Transaction type',d.transactionType)+field('notes','Notes',d.notes,'textarea')}</div>
      <div class="payment-choice">${toggle('includePayment','Print a payment QR on this invoice',d.includePayment)}${select('paymentMethod','Payment QR type',d.paymentMethod??'bank',[['upi','UPI · scan to pay'],['bank','Bank transfer details']])}</div>
      <p class="muted">Add your payment details in Settings. UPI payments are recorded after you confirm receipt.</p>`)}
    ${state.settings.irp==='external'?section('IRP response',`<p class="notice">For applicable invoices, obtain the IRN and signed QR from your external Invoice Registration Portal workflow.</p><div class="grid">${
      field('irn','Invoice Reference Number',d.irn,'text','maxlength="64"')+field('signedQr','Signed QR text',d.signedQr,'textarea')}</div>`):''}
    </div></div><section class="card preview pane"><div class="preview-head"><h2>Print preview</h2><div class="actions">${btn('prev-page','‹','square','aria-label="Previous page"')}
      <span id="page-label" class="muted">1 / 1</span>${btn('next-page','›','square','aria-label="Next page"')}${btn('zoom',state.zoom?'Fit':'100%','','aria-label="Change preview zoom"')}</div></div>
    <div id="preview-paper" class="paper-wrap ${state.zoom?'zoomed':''}"></div><p id="preview-error" class="paper-error" hidden></p>
    <div class="totalsbar"><span class="muted">Invoice total</span><strong id="preview-total">${amount(0)}</strong></div></section></div>`;
}
function customerRows() {
  const results = state.customers.filter(c=>search(state.customerFilter,[c.name,c.billing?.gstin,c.billing?.address,c.email,c.phone]));
  if (!results.length) return `<div class="empty">${icon('people')}<h2>${state.customerFilter?'No matching customers':'No saved customers yet'}</h2>
    <p>Save billing and shipping details once, then fill them in from any new invoice.</p></div>`;
  return `<div class="table-wrap"><table><thead><tr><th>Customer</th><th>GSTIN</th><th>Contact</th><th>Actions</th></tr></thead><tbody>${results.map(c=> {
    const attr=`data-id="${e(c.id)}"`;
    return `<tr><td><strong>${e(c.name)}</strong><br><small>${e(c.billing?.state)}</small></td><td>${e(c.billing?.gstin)||'—'}</td>
      <td>${e(c.email||c.billing?.email||c.phone||c.billing?.phone)||'—'}</td><td><div class="actions">${btn('edit-customer','Edit','',attr)}${btn('remove-customer','Delete','subtle danger',attr)}</div></td></tr>`;
  }).join('')}</tbody></table></div>`;
}
function customersView() {
  return heading('Customers','Manage contacts and their default billing and shipping details.',btn('new-customer','New customer','primary','','plus'),'Address book')+
    `<section class="card"><div class="listbar">${searchBox('customerSearch',state.customerFilter,'Search customers')}</div><div id="customer-rows">${customerRows()}</div></section>`;
}
function contactView() {
  const c=state.customer;
  return heading(c.id?'Edit customer':'New customer','Changes apply when you select this customer on a future invoice.',
    btn('cancel-customer','Cancel')+btn('save-customer','Save customer','primary','','save'),'Address book')+
    `<div id="contact-form" class="panel-list">${section('Customer contact',`<div class="grid three">${field('name','Display name',c.name)+
      field('email','Email',c.email,'email')+field('phone','Phone',c.phone,'tel')}</div>`)}
    ${section('Billing details',partyGrid('billing',c.billing))}
    ${section('Default shipping details',partyGrid('shipping',c.shipping),btn('copy-customer-address','Copy billing details','subtle'))}</div>`;
}
function layoutView() {
  const template=state.layout;
  const item=template.blocks[state.selected];
  const choices=[['freight','Freight · SSKT layout'],['standard','Standard · A4 landscape'],
    ...Object.entries(state.settings.savedTemplates ?? {}).map(([key,value])=>[key,value.name])];
  const nums=[['x','Left'],['y','Top'],['w','Width'],['h','Height'],['size','Font size']];
  return heading('PDF layout editor','Move or resize fields on the page. Use the inspector for exact measurements and column widths.',
    btn('layout-undo','Undo','',state.layoutUndo.length?'':'disabled')+btn('layout-redo','Redo','',state.layoutRedo.length?'':'disabled')+btn('layout-snap',state.snap?'Grid on':'Grid off')+btn('save-layout','Save layout','primary','','save'),'Print design')+
    `<div class="layout-work"><section class="card"><div class="preview-head"><h2>Template preview</h2><div class="actions"><span class="pill">Sample data</span>${btn('layout-zoom',state.layoutZoom?'Fit':'100%')}</div></div>
      <div id="layout-stage" class="paper-wrap layout-stage ${state.layoutZoom?'zoomed':''}" aria-label="Draggable invoice preview"></div><p id="layout-error" class="paper-error" hidden></p></section>
    <div class="layout-properties">${section('Templates',`<div class="panel-list">
    ${select('layoutPreset','Load a template','',[['','Select template'],...choices])}
    ${field('templateName','Save a named copy',state.layoutName || '','text','maxlength="60"')}
    <div class="actions">${btn('save-layout-copy','Save copy')}</div></div>`)}<section class="card card-pad" id="paper-settings"><div class="cardhead"><h2>Paper</h2></div><div class="grid">
      ${field('width','Width (pt)',template.width,'number','min="300" max="1800" step="0.01"')+field('height','Height (pt)',template.height,'number','min="300" max="1800" step="0.01"')}</div>
      <div class="actions">${btn('resize-paper','Apply')}${btn('a4-landscape','A4 landscape','subtle')}</div></section>
    <section class="card card-pad" id="block-settings"><div class="cardhead"><h2>Section properties</h2></div>
      <div class="panel-list">${select('section','Section',state.selected,templateSections(template).map(key=>[key,template.blocks[key].label||key]))}
      <div class="grid">${field('label','Label',item.label,'text','maxlength="70"')+
      nums.map(([key,label])=>field(key,label,item[key],'number','min="0" max="1800" step="0.1"')).join('')+
      select('align','Text alignment',item.align??'left',[['left','Left'],['center','Center'],['right','Right']])+
      field('color',state.selected.endsWith('Rule')?'Rule color':'Text color',item.color,'color')+toggle('border',state.selected.endsWith('Rule')?'Show rule':'Show border',item.border)}</div></div></section>
    ${template.kind==='freight'&&state.selected==='items'?`<section class="card card-pad" id="column-settings"><div class="cardhead"><h2>Column proportions</h2></div>
      <div class="grid">${freightColumns.map(([key,label,ratio])=>field(key,label,template.columns?.[key]??(ratio*100).toFixed(1),'number','min="2" max="60" step="0.1"')).join('')}</div></section>`:''}
    </div></div>`;
}
function settingsView() {
  const s=state.settings;
  const connected=state.drive.connected;
  return heading('Settings','Manage your business details, GST and desktop preferences.',
    btn('save-settings','Save settings','primary','','save'),'Workspace preferences')+
    `<div id="settings-form" class="panel-list">${setupChecklist(true)}
    ${section('Appearance',`<div class="appearance-setting"><div><h3>Theme</h3><p class="muted">Use the computer to follow Windows, the sun for Light, or the moon for Dark.</p></div>${appearanceControls()}</div>
    <div class="material-choices" role="group" aria-label="Window style">${[['beautiful','Glass','Frosted panels, depth and Windows background blur.'],['performance','Performance','Opaque surfaces, fewer effects and minimal motion.']].map(([value,title,caption])=>
      `<button type="button" data-action="material-mode" data-material-mode="${value}" class="material-choice ${value}" aria-pressed="${visualMode()===value}"><span class="material-sample"><i></i><i></i><i></i></span><span><strong>${title}</strong><small>${caption}</small></span><span class="material-check">${icon('check')}</span></button>`).join('')}</div>
    <p class="muted material-note">Windows background blur is available on supported Windows 11 systems. Frosted app panels work on other systems. Windows accessibility preferences are respected.</p>
    <div class="accent-grid">${accentControls('light')}${accentControls('dark')}</div><p class="muted appearance-note">Each theme remembers its own accent. Changes save automatically on this PC and leave printed invoices unchanged.</p>
    <div class="appearance-setting"><div class="display-description"><h3>Smart sizing ✨</h3><p class="muted" data-display-hint></p><small>Your choice is remembered on this PC. Invoice print size stays the same.</small></div>${
      select('interfaceSize','Interface size',interfaceSize(),interfaceSizes.map(value=>[value,value==='smart'?'Smart ✨ (recommended)':`${value}%`]))}</div>
    <div class="grid preference-grid">${select('density','Spacing',density(),[['comfortable','Comfortable'],['compact','Compact']])}</div>`, '', 'settings-appearance')}
    ${section('Supplier profile',partyGrid('seller',s.seller)+`<div class="grid">${field('seller.tagline','Tagline',s.seller?.tagline)+field('seller.website','Website',s.seller?.website)}
    <label class="field"><span>Logo (PNG or JPEG)</span><input type="file" name="logo" accept="image/png,image/jpeg"></label></div>
    <div class="swatch">${validLogo(s.seller?.logo)?`<img src="${s.seller.logo}" alt="Supplier logo">${btn('remove-logo','Remove logo','subtle')}`:''}</div>`)}
    ${section('India GST e-invoicing',`<div class="grid">${select('irp','Invoice Registration Portal (IRP)',s.irp,[
      ['review','Choose before issuing'],['notRequired','IRP registration does not apply to this workflow'],['external','Bring IRN and signed QR from my IRP workflow']
    ])}</div><p class="muted">Confirm applicability for your business and transactions. The app accepts the official response details you provide.</p>`)}
    ${section('UPI payments',`<p class="muted">Use the UPI ID from your business’s payment app. Check the recipient in your UPI app before sharing an invoice.</p><div class="grid">${field('payment.upiId','Business UPI ID',s.payment?.upiId,'text','placeholder="business@bank" maxlength="320"')+field('payment.upiName','Payee name',s.payment?.upiName,'text','maxlength="100"')}</div>`, '', 'settings-upi')}
    ${section('Bank transfer QR',`<p class="notice">Optional. These details are stored on this PC and printed only when you enable the bank QR on an invoice.</p>
      <div class="grid">${paymentFields.map(([key,label])=>field('payment.'+key,label,s.payment?.[key],'text',key==='account'?'inputmode="numeric" maxlength="40" autocomplete="off"':'maxlength="75" autocomplete="off"')).join('')}</div>`)}
    ${section('Google Drive',`<div class="meta-line"><p>${connected?`Connected${state.drive.email?' as '+e(state.drive.email):''}.`:'Connect a Google Desktop OAuth client to upload issued PDFs.'}</p>
      <span class="tag ${connected?'ok':''}">${connected?'Connected':'Disconnected'}</span></div>
      ${connected?`<p class="notice">New uploads are private. Use Share on a specific invoice to turn on anyone-with-the-link access.</p>
        ${toggle('driveAuto','Automatically upload newly issued invoices',s.driveAuto)}`:
        `<div id="drive-form" class="grid">${field('clientId','Desktop OAuth client ID','','text','autocomplete="off"')+
           field('clientSecret','Desktop OAuth client secret','','password','autocomplete="off"')}</div><p class="muted">Setup steps are in the project README.</p>`}`,
      connected?btn('disconnect','Disconnect','subtle'):btn('connect','Connect Google Drive','','','cloud'))}
    ${section('Local data',`<p class="muted">Import your Python invoice and customer history or create a copy of this workspace database.</p>
    ${state.note?`<p class="notice">${e(state.note)}</p>`:''}`,btn('import','Import from Python')+btn('backup','Create backup')+btn('restore','Restore backup','subtle'))}
    </div>`;
}
function render() {
  root.innerHTML = frame({invoices:invoicesView,draft:draftView,customers:customersView,contact:contactView,layout:layoutView,settings:settingsView,services:servicesView,service:serviceView,payments:paymentsView,help:helpView}[state.view]());
  paintDisplayControls();
  paintColorControls();
  if(state.view==='draft') preview();
  if(state.view==='layout') layoutPreview();
}
function example() {
  return {
    number:'INV-0042',date:'2026-11-04',seller:{name:'Example Freight Studio',address:'12 Sample Lane, Pune 411001',gstin:'27ABCDE1234F1Z5'},
    buyer:{name:'Harbour Demo Works',address:'41 Sample Road, Mumbai 400001',state:'Maharashtra',stateCode:'27',gstin:'27AAAAA1111A1Z5'},
    ship:{name:'Harbour Demo Receiving',address:'14 Example Road, Mumbai 400001'},placeOfSupply:'Maharashtra',
    placeOfSupplyCode:'27',regime:'split',order:'PO-102',container:'DEMO 001',origin:'Pune',destination:'Mumbai',
    items:[{...emptyLine(),description:'Domestic freight service',hsn:'996511',quantity:'1',unit:'NOS',unitPrice:'1500',gstRate:'18'}],
    notes:'Thank you for your business.'
  };
}
const ctx=document.createElement('canvas').getContext('2d');
const measure=(value,size,style)=>{ctx.font=`${style ?? "normal"} ${size}px "Invoice Sans"`;return ctx.measureText(value).width;};
let lastQR;
async function qrFor(data, quote) {
  const payload=qrPayload(data,quote.totals);
  if(lastQR?.payload!==payload) lastQR={payload,promise:invoke('encode_qr',{payload})};
  return lastQR.promise;
}
let lastPaymentQR;
function bankQrFor(data,quote) {
  const payload=paymentQrPayload(data.payment,{...quote?.totals,number:data.number,date:data.date});
  if(!payload) return null;
  if(lastPaymentQR?.payload!==payload)lastPaymentQR={payload,promise:invoke('encode_qr',{payload})};
  return lastPaymentQR.promise;
}
async function preview() {
  const stamp=++state.latestPreview;
  const paper=document.querySelector('#preview-paper');
  const message=document.querySelector('#preview-error');
  if(!paper || !message) return;
  try {
    const d=invoiceSnapshot();
    const quote=await invoke('quote_invoice',{value:d});
    const [qr,paymentQr]=await Promise.all([qrFor(d,quote),bankQrFor(d,quote)]);
    const template=activeTemplate();
    const pages=documentPages(d,quote,template,qr,measure,{paymentQr});
    if(stamp!==state.latestPreview || !paper.isConnected) return;
    state.page=Math.max(0,Math.min(state.page,pages.length-1));
    paper.style.setProperty('--paper-width',template.width+'px');
    paper.innerHTML=toSvg(template,pages[state.page]);
    document.querySelector('#page-label').textContent=`${state.page+1} / ${pages.length}`;
    document.querySelector('#preview-total').textContent=amount(quote.totals.total);
    message.hidden=true;
  } catch(err) {
    if(stamp!==state.latestPreview || !paper.isConnected) return;
    message.textContent=text(err.message??err);message.hidden=false;
    document.querySelector('#preview-total').textContent='—';
  }
}
function layoutPreview() {
  const node=document.querySelector('#layout-stage');
  const warning=document.querySelector('#layout-error');
  if(!node || !warning) return;
  const d=example();
  const line={taxable:150000,cgst:13500,sgst:13500,total:177000};
  try {
    const pages=documentPages(d,{lines:[line],totals:line},state.layout,state.exampleQr,measure,{paymentQr:state.exampleQr});
    node.style.setProperty('--paper-width',state.layout.width+'px');
    node.innerHTML=toSvg(state.layout,pages[0],true,state.selected,state.snap);
    checkTemplate(state.layout);
    warning.hidden=true;
  } catch(err) {
    warning.textContent=text(err.message??err);warning.hidden=false;
  }
}
let draftTimer, draftWrite=Promise.resolve();
function queueDraft() {
  clearTimeout(draftTimer);
  state.draftRevision++;state.draftSaveStatus='saving';updateDraftStatus();
  draftTimer=setTimeout(()=>persistDraft().catch(error=>notify(error,true)),450);
}
function persistDraft() {
  clearTimeout(draftTimer);
  const value=state.draft?clone(state.draft):null;
  const revision=state.draftRevision;
  draftWrite=draftWrite.catch(()=>{}).then(()=>invoke('save_draft',{value})).then(()=>{
    if(revision===state.draftRevision){state.draftSaveStatus='saved';state.savedAt=new Date();updateDraftStatus();}
  },error=>{if(revision===state.draftRevision){state.draftSaveStatus='error';updateDraftStatus();}throw error;});
  return draftWrite;
}
async function refresh() {
  const [s, customers, invoices, drive, services, info]=await Promise.all(['get_settings','list_customers','list_invoices','drive_status','list_services','app_info'].map(c=>invoke(c)));
  Object.assign(state,{settings:s,customers,invoices,drive,services,info});
}
async function openDraft(base=null) {
  if(base || !state.draft) {
    const date=today();
    const number=await invoke('new_number',{date});
    const source=base?clone(base):{};
    delete source.payment;delete source.includePayment;delete source.paymentMethod;delete source.printDate;delete source.dueDate;
    delete source.seller;delete source.irn;delete source.signedQr;delete source.legacySource;
    state.draft={buyer:{},ship:{},regime:'split',paymentMethod:state.settings.payment?.upiId?'upi':'bank',items:[emptyLine()],...source,date,number};
    if(!state.draft.items?.length) state.draft.items=[emptyLine()];
    state.draftSearch='';state.draftServiceFilter='';
    await persistDraft();
  }
  state.fieldErrors={};state.issueError='';
  state.view='draft';state.page=0;state.panel='form';state.editorTab='details';render();
}
function readSettings(form) {
  const next=clone(state.settings);
  for(const input of form.querySelectorAll('input:not([type=file]):not(#drive-form input),select,textarea')) {
    if(input.name && !input.matches('[data-appearance], [data-accent-control], [name=interfaceSize], [name=visualMode], [name=density]')) setByPath(next,input.name,input.type==='checkbox'?input.checked:input.value);
  }
  return next;
}
function reprint() {
  if(state.view==='draft') preview();
}
function asBase64(bytes) {
  let output='';
  for(let i=0;i<bytes.length;i+=16384) output+=String.fromCharCode(...bytes.subarray(i,i+16384));
  return btoa(output);
}
const fontBytes=()=>fetch('./assets/DejaVuSans.ttf').then(r=>{if(!r.ok)throw new Error('Invoice font could not load.');return r.arrayBuffer();});
async function issue() {
  if(state.locked || modal.open) return;
  if(!validateDraftFields())return;
  if(!await confirm('Issue this invoice?', 'This saves the invoice number, customer details and PDF as a record. You can duplicate it for a future invoice.', 'Issue invoice')) return;
  state.locked=true;
  render();
  try {
    const data=invoiceSnapshot();
    const quote=await invoke('validate_invoice',{value:data});
    if(data.includePayment && !paymentQrPayload(data.payment,{total:quote.totals.total,number:data.number,date:data.date})) throw new Error('Complete the selected payment details in Settings before printing a payment QR.');
    const [qr,paymentQr,bytes]=await Promise.all([qrFor(data,quote),bankQrFor(data,quote),fontBytes()]);
    if(!globalThis.fontkit) throw new Error('The embedded PDF font library could not load. Reinstall Invoicer In.');
    const pdf=await makePdf({pdfLib:globalThis.PDFLib,fontkit:globalThis.fontkit,fontBytes:bytes,data,quote,template:activeTemplate(),qr,paymentQr});
    await invoke('issue_invoice',{value:data,pdf:asBase64(pdf)});
    state.draft=null;state.view='invoices';
    try { await persistDraft();await refresh(); }
    catch(err) { notify(`Invoice issued. ${err.message??err}`,true);return; }
    notify(`Invoice ${data.number} issued.`);
  } catch(error) {
    state.issueError=text(error.message??error);
    showDraftError(state.issueError);
  } finally { state.locked=false;render(); }
}
async function copyLink(url) {
  try { await navigator.clipboard.writeText(url);notify('Drive link copied.'); }
  catch { await confirm('Drive link',url,'Done'); }
}

root.addEventListener('input', event => {
  const input=event.target;
  const name=input.name;
  if(!name || input.type==='file'||name==='serviceCatalog') return;
  if(input.matches('[data-accent-control]')) {
    if(input.type==='color'||/^#[\da-f]{6}$/i.test(input.value))setAccentColor(input.dataset.accentControl,input.value);
    return;
  }
  if(state.fieldErrors[name]){delete state.fieldErrors[name];input.removeAttribute('aria-invalid');input.closest('.field')?.querySelector('.field-error')?.remove();}
  if(name==='draftServiceSearch'){state.draftServiceFilter=input.value;document.querySelector('#service-picker-options').innerHTML=serviceOptions();return;}
  if(name==='serviceSearch'){state.serviceFilter=input.value;document.querySelector('#service-rows').innerHTML=serviceRows();return;}
  if(input.closest('#service-form')){setByPath(state.service,name,input.value);return;}
  if(input.closest('#payment-form')){setByPath(state.paymentForm,name,input.value);return;}
  if(name==='invoiceSearch') {
    state.filter=input.value;document.querySelector('#invoice-rows').innerHTML=invoiceRows();return;
  }
  if(name==='customerSearch') {
    state.customerFilter=input.value;document.querySelector('#customer-rows').innerHTML=customerRows();return;
  }
  if(name==='draftCustomerSearch') {
    state.draftSearch=input.value;
    const candidates=state.customers.filter(c=>search(state.draftSearch,[c.name,c.billing?.gstin,c.email,c.phone]));
    document.querySelector('#draft-customer-list').innerHTML=select('customerId','Saved customer',state.draft.customerId,
      [['','Choose a saved customer'],...candidates.map(c=>[c.id,`${c.name}${c.billing?.gstin?' · '+c.billing.gstin:''}`])]);
    return;
  }
  const value=input.type==='checkbox'?input.checked:input.value;
  if(input.closest('#draft-form') && !state.locked) {
    if(name==='placeOfSupplyCode') {
      const previous=state.draft.placeOfSupplyCode;
      state.draft.placeOfSupply=gstStates.get(value) ?? (value && value===previous ? state.draft.placeOfSupply : '');
    }
    setByPath(state.draft,name,value);
    queueDraft();
    if(name!=='customerId') {
      clearTimeout(reprint.timer);
      reprint.timer=setTimeout(reprint,140);
    }
  } else if(input.closest('#contact-form')) {
    setByPath(state.customer,name,value);
  } else if(name==='templateName' && state.view==='layout') {
    state.layoutName=value;
  } else if(input.closest('#column-settings')) {
    const n=Number(value);
    if(!Number.isFinite(n)||n<2||n>60) return;
    if(!input.dataset.history) {rememberLayout();input.dataset.history='yes';}
    (state.layout.columns ??= {})[name]=n;
    layoutPreview();
  } else if(input.closest('#block-settings') && name!=='section') {
    if(input.type==='number' && input.value==='') return;
    if(!input.dataset.history) {rememberLayout();input.dataset.history='yes';}
    state.layout.blocks[state.selected][name]=input.type==='number'?Number(value):value;
    layoutPreview();
  }
});
root.addEventListener('change', async event => {
  const input=event.target;
  if(input.matches('[data-accent-control]')) {
    if(!setAccentColor(input.dataset.accentControl,input.value)) {
      input.setAttribute('aria-invalid','true');notify('Enter a color such as #086e66.',true);
    }
    return;
  }
  if(input.name==='visualMode'){setVisualMode(input.value);return;}
  if(input.name==='density'){setDensity(input.value);return;}
  if(input.matches('[data-appearance]')) {setAppearance(input.value);return;}
  if(input.name==='interfaceSize') {
    try {await setInterfaceSize(input.value);}
    catch(error) {input.value=interfaceSize();notify(error.message??error,true);}
    return;
  }
  if(state.view==='layout' && input.name==='layoutPreset' && input.value) {
    const choices={freight:freightTemplate,standard:defaultTemplate};
    loadLayout(choices[input.value] ?? state.settings.savedTemplates[input.value].template);
  }
  if(state.view==='layout' && (input.closest('#block-settings') || input.closest('#column-settings')) && input.name!=='section') {
    delete input.dataset.history;
    updateHistoryButtons();
  }
  if(input.name==='section' && state.view==='layout') {
    state.selected=input.value;render();
  }
  if(input.name==='logo' && input.files?.[0]) {
    const file=input.files[0];
    if(!['image/png','image/jpeg'].includes(file.type) || file.size>1_250_000) {
      notify('Choose a PNG or JPEG logo under 1.25 MB.',true);return;
    }
    try {
      const form=document.querySelector('#settings-form');
      const previous=state.settings;
      const next=readSettings(form);
      const image=await new Promise((resolve,reject)=> {
        const reader=new FileReader();
        reader.onload=()=>resolve(reader.result);
        reader.onerror=()=>reject(new Error('The logo could not be read.'));
        reader.readAsDataURL(file);
      });
      if(state.settings!==previous || !form.isConnected) return;
      next.seller.logo=image;
      state.settings=next;render();
      notify('Logo loaded. Select Save settings to keep it.');
    } catch(err) {notify(err.message??err,true);}
  }
});
function updateHistoryButtons() {
  const undo=document.querySelector('[data-action=layout-undo]');
  const redo=document.querySelector('[data-action=layout-redo]');
  if(undo) undo.disabled=!state.layoutUndo.length;
  if(redo) redo.disabled=!state.layoutRedo.length;
}
let drag;
root.addEventListener('pointerdown', event => {
  const box=event.target.closest('[data-section]');
  if(!box || state.view!=='layout' || event.button!==0) return;
  const stage=event.target.closest('#layout-stage');
  const rect=stage.querySelector('svg').getBoundingClientRect();
  const section=box.dataset.section;
  const data=state.layout.blocks[section];
  state.selected=section;
  drag={stage,section,id:event.pointerId,x:event.clientX,y:event.clientY,left:data.x,top:data.y,width:data.w,height:data.h,resize:box.dataset.resize,previous:clone(state.layout),
    sx:state.layout.width/rect.width,sy:state.layout.height/rect.height};
  stage.setPointerCapture(event.pointerId);
  layoutPreview();
  event.preventDefault();
});
root.addEventListener('pointermove', event => {
  if(drag?.id!==event.pointerId) return;
  const b=state.layout.blocks[drag.section];
  const round=state.snap?4:.1;
  const clamp=(value,min,max)=>Math.max(min,Math.min(max,Math.round(value/round)*round));
  const dx=(event.clientX-drag.x)*drag.sx,dy=(event.clientY-drag.y)*drag.sy;
  if(drag.resize) {
    b.w=clamp(drag.width+dx,25,state.layout.width-b.x);
    b.h=clamp(drag.height+dy,drag.section.endsWith('Rule')?1:state.layout.kind==='freight'?8:14,state.layout.height-b.y);
  } else {
    b.x=clamp(drag.left+dx,0,state.layout.width-b.w);
    b.y=clamp(drag.top+dy,0,state.layout.height-b.h);
  }
  layoutPreview();
});
function endDrag(event) {
  if(drag?.id===event.pointerId) {
    if(event.type==='pointercancel')state.layout=drag.previous;
    else if(JSON.stringify(state.layout)!==JSON.stringify(drag.previous))rememberLayout(drag.previous);
    drag=null;render();
  }
}
root.addEventListener('pointerup',endDrag);
root.addEventListener('pointercancel',endDrag);

root.addEventListener('click', async event => {
  const button=event.target.closest('button[data-action]');
  if(!button || button.disabled) return;
  const {action,id}=button.dataset;
  if(state.locked && !['panel','prev-page','next-page','zoom','appearance'].includes(action)) return;
  try {
    if(action==='appearance'){setAppearance(button.dataset.appearance);return;}
    if(action==='toggle-glass'){setVisualMode(visualMode()==='beautiful'?'performance':'beautiful');return;}
    if(action==='material-mode'){setVisualMode(button.dataset.materialMode);return;}
    if(action==='accent-preset'){setAccentColor(button.dataset.theme,button.dataset.accentPreset);return;}
    if(action==='accent-reset'){resetAccentColor(id);return;}
    if(action==='display-settings') {
      if(state.view==='draft') await persistDraft();
      if(state.view!=='settings'){state.view='settings';state.fieldErrors={};render();}
      document.querySelector('#settings-appearance')?.scrollIntoView({block:'start'});
      document.querySelector('[name="interfaceSize"]')?.focus({preventScroll:true});
    } else if(action==='nav') {
      if(state.view==='draft') await persistDraft();
      if(state.view==='settings') state.settings=await invoke('get_settings');
      state.view=id;state.fieldErrors={};
      if(id==='layout') {state.layout=clone(activeTemplate());state.layoutUndo=[];state.layoutRedo=[];state.selected='items';}
      render();
    } else if(await businessAction(action,id,button)) {return;}
    else if(action==='new') { await openDraft(); }
    else if(action==='discard') {
      if(!await confirm('Discard this draft?','This removes the current draft from this PC.','Discard draft')) return;
      state.draft=null;await persistDraft();state.view='invoices';render();
    } else if(action==='duplicate') {
      if(state.draft && !await confirm('Replace the current draft?','Open a copy of the selected invoice in the editor.','Replace draft')) return;
      await openDraft(await invoke('get_invoice',{id}));
    } else if(action==='panel' || action==='editor-tab') {
      if(action==='panel') state.panel=id;
      else state.editorTab=id;
      render();
      root.querySelector(`[data-action="${action}"][data-id="${id}"]`).focus({preventScroll:true});
    } else if(action==='preview-mode') {
      state.splitView=!state.splitView;localStorage.setItem('invoicer-preview-mode',state.splitView?'split':'form');render();
      root.querySelector('[data-action="preview-mode"]').focus({preventScroll:true});
    }
    else if(action==='save-draft') {await persistDraft();notify('Draft saved.');}
    else if(action==='zoom') {state.zoom=!state.zoom;render();}
    else if(action==='prev-page' || action==='next-page') {state.page+=action==='prev-page'?-1:1;preview();}
    else if(action==='next-number') {
      state.draft.number=await invoke('new_number',{date:state.draft.date});queueDraft();render();
    } else if(action==='add-item') {
      if(state.draft.items.length>=250) throw new Error('An invoice supports up to 250 lines.');
      state.draft.items.push(emptyLine());queueDraft();render();
    } else if(action==='remove-item') {
      if(state.draft.items.length>1) state.draft.items.splice(Number(id),1);
      queueDraft();render();
    } else if(action==='same-address') {
      state.draft.ship=clone(state.draft.buyer);queueDraft();render();
    } else if(action==='apply-customer') {
      const selected=document.querySelector('[name=customerId]').value;
      const c=state.customers.find(person=>person.id===selected);
      if(!c) throw new Error('Choose a saved customer first.');
      state.draft.customerId=c.id;
      state.draft.buyer={...clone(c.billing??{}),name:c.billing?.name||c.name,
        email:c.billing?.email||c.email||'',phone:c.billing?.phone||c.phone||''};
      state.draft.ship=clone(c.shipping??{});
      queueDraft();render();notify('Customer details filled in.');
    } else if(action==='issue') {await issue();}
    else if(action==='export') {if(await invoke('export_invoice',{id})) notify('PDF exported.');}
    else if(action==='register') {
      const rows=state.invoices.filter(row=>search(state.filter,[row.number,row.buyer,row.day,row.driveStatus]));
      if(await invoke('export_register',{csv:csvRegister(rows)})) notify('Invoice register exported.');
    } else if(action==='new-customer' || action==='edit-customer' || action==='from-draft') {
      state.fromDraft=action==='from-draft';
      state.customer=action==='edit-customer'?clone(state.customers.find(c=>c.id===id)):
        state.fromDraft?{name:state.draft.buyer?.name??'',billing:clone(state.draft.buyer??{}),shipping:clone(state.draft.ship??{})}:
        {name:'',billing:{},shipping:{}};
      if(state.fromDraft) await persistDraft();
      state.view='contact';render();
    } else if(action==='cancel-customer') {
      state.view=state.fromDraft?'draft':'customers';render();
    } else if(action==='copy-customer-address') {
      state.customer.shipping=clone(state.customer.billing);render();
    } else if(action==='save-customer') {
      button.disabled=true;
      try {
        const customer=await invoke('save_customer',{value:state.customer});
        state.customers=await invoke('list_customers');
        if(state.fromDraft) {state.draft.customerId=customer.id;state.editorTab='customer';queueDraft();}
        state.view=state.fromDraft?'draft':'customers';render();notify('Customer saved.');
      } finally {button.disabled=false;}
    } else if(action==='remove-customer') {
      if(!await confirm('Delete this customer?','Previously issued invoices retain their saved customer details.','Delete customer')) return;
      await invoke('delete_customer',{id});state.customers=await invoke('list_customers');render();notify('Customer deleted.');
    } else if(action==='resize-paper' || action==='a4-landscape') {
      const width=action==='a4-landscape'?defaultTemplate.width:Number(document.querySelector('#paper-settings [name=width]').value);
      const height=action==='a4-landscape'?defaultTemplate.height:Number(document.querySelector('#paper-settings [name=height]').value);
      if(![width,height].every(n=>Number.isFinite(n)&&n>=300&&n<=1800)) throw new Error('Enter paper dimensions between 300 and 1,800 points.');
      loadLayout(resizePaper(state.layout,width,height));
    } else if(action==='reset-layout') {
      if(!await confirm('Reset the layout?','Restore the included landscape template in the editor.','Reset layout')) return;
      loadLayout(state.layout.kind==='freight'?freightTemplate:defaultTemplate);
    } else if(action==='layout-snap') {state.snap=!state.snap;render();}
    else if(action==='layout-zoom') {state.layoutZoom=!state.layoutZoom;render();}
    else if(action==='layout-undo' || action==='layout-redo') {
      const [from,to]=action==='layout-undo'?[state.layoutUndo,state.layoutRedo]:[state.layoutRedo,state.layoutUndo];
      const previous=from.pop();
      if(previous) {
        to.push(clone(state.layout));state.layout=previous;
        if(!state.layout.blocks[state.selected])state.selected='items';
        render();
      }
    } else if(action==='save-layout' || action==='save-layout-copy') {
      checkTemplate(state.layout);
      const sample=example();
      const line={taxable:150000,cgst:13500,sgst:13500,cess:0,total:177000};
      documentPages(sample,{lines:[line],totals:line},state.layout,state.exampleQr,measure,{strict:true,paymentQr:state.exampleQr});
      const value={...state.settings,template:clone(state.layout)};
      if(action==='save-layout-copy') {
        const name=(state.layoutName ?? '').trim();
        if(!name) throw new Error('Enter a name for this template copy.');
        value.savedTemplates={...value.savedTemplates,[crypto.randomUUID()]:{name,template:clone(state.layout)}};
      }
      state.settings=await invoke('save_settings',{value});notify('Layout saved.');
    } else if(action==='save-settings') {
      const s=readSettings(document.querySelector('#settings-form'));
      state.settings=await invoke('save_settings',{value:s});render();notify('Settings saved.');
    } else if(action==='remove-logo') {
      state.settings=readSettings(document.querySelector('#settings-form'));
      delete state.settings.seller.logo;render();notify('Logo removed. Select Save settings to keep the change.');
    } else if(action==='connect') {
      const form=document.querySelector('#settings-form');
      const clientId=form.querySelector('[name=clientId]').value;
      const clientSecret=form.querySelector('[name=clientSecret]').value;
      state.settings=await invoke('save_settings',{value:readSettings(form)});
      button.disabled=true;
      notify('Complete Google sign-in in your browser.');
      try {await invoke('drive_connect',{clientId,clientSecret});}
      finally {button.disabled=false;}
      await refresh();render();notify('Google Drive connected.');
    } else if(action==='disconnect') {
      if(!await confirm('Disconnect Google Drive?','Future invoices will stay on this PC. Files already uploaded will remain in your Drive.','Disconnect')) return;
      await invoke('drive_disconnect');await refresh();render();notify('Google Drive disconnected.');
    } else if(action==='retry') {
      await invoke('drive_retry',{id});await refresh();render();notify('Upload queued again.');
    } else if(action==='share-link' || action==='copy-link') {
      const makePublic=action==='share-link';
      if(makePublic && !await confirm('Allow anyone with the link to view this invoice?',
          'Anyone who receives the link can open the PDF. You can remove this permission in Google Drive.','Enable link sharing')) return;
      await copyLink(await invoke('drive_link',{id,public:makePublic}));
    } else if(action==='backup') {
      if(await invoke('backup')){state.info=await invoke('app_info');render();notify('Workspace backup created.');}
    } else if(action==='import') {
      const report=await invoke('import_legacy');
      if(!report) return;
      await refresh();
      state.note=`Imported ${report.invoices} invoice(s) and ${report.customers} customer(s). Skipped ${report.skipped} record(s).`+
        (report.warnings.length?'\n'+report.warnings.slice(0,8).join('\n'):'');
      state.view='settings';render();notify('Import complete.');
    }
  } catch(err) {notify(err.message??err,true);}
});

async function start() {
  if(!globalThis.__TAURI__?.core?.invoke) {
    root.innerHTML='<div class="splash">Open this workspace from the Invoicer In desktop app.</div>';
    return;
  }
  try {
    await displayReady;
    await refresh();
    state.draft=await invoke('get_draft');
    await document.fonts.load('10px "Invoice Sans"');
    state.exampleQr=await invoke('encode_qr',{payload:qrPayload(example(),{total:177000})});
    render();
    const desktopWindow=globalThis.__TAURI__?.window?.getCurrentWindow();
    await desktopWindow?.onCloseRequested?.(async event=>{
      event.preventDefault();
      if(state.locked){notify('Finish the current operation before closing.');return;}
      try {await persistDraft();await desktopWindow.destroy();}
      catch(error){notify(`Save the draft before closing. ${error.message??error}`,true);}
    });
    setInterval(async () => {
      if(state.view!=='invoices') return;
      try {
        const rows=await invoke('list_invoices');
        if(state.view!=='invoices' || JSON.stringify(rows)===JSON.stringify(state.invoices)) return;
        state.invoices=rows;
        render();
      } catch { /* Keep the existing register available during a transient database error. */ }
    },4500);
  } catch(err) {root.innerHTML=`<div class="splash">${e(err.message??err)}</div>`;}
  finally {
    await globalThis.__TAURI__?.window?.getCurrentWindow()?.show?.().catch(error=>notify(error.message??error,true));
  }
}
start();

function draftStatusText() {
  if(state.draftSaveStatus==='saving')return 'Saving…';
  if(state.draftSaveStatus==='error')return 'Save failed · try Save draft';
  return state.savedAt?`Saved ${state.savedAt.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}`:'Saved on this PC';
}
function updateDraftStatus() {
  const node=document.querySelector('#draft-save-status');
  if(node){node.textContent=draftStatusText();node.classList.toggle('error',state.draftSaveStatus==='error');}
}
function setupChecklist(inSettings=false) {
  const s=state.settings;
  const supplier=Boolean(s.seller?.name&&s.seller?.address&&s.seller?.gstin);
  const tax=['external','notRequired'].includes(s.irp);
  const payment=Boolean(paymentQrPayload({...s.payment,method:'upi'})||paymentQrPayload(s.payment));
  if(!inSettings&&supplier&&tax)return '';
  return section('Business setup',`<p class="muted">Save your business details once, then reuse them on every invoice.</p><div class="setup-steps">${[
    ['supplier','Business details',supplier,'Name, GSTIN, address and logo'],['tax','GST workflow',tax,'Confirm your e-invoicing workflow'],['payment','Payment details',payment,'UPI or bank details · optional']
  ].map(([id,label,done,hint])=>`<button type="button" data-action="setup-step" data-id="${id}" class="setup-step"><span class="step-check ${done?'done':''}">${icon(done?'check':'arrow')}</span><span><strong>${label}</strong><small>${hint}</small></span></button>`).join('')}</div>`);
}
function serviceOptions() {
  return select('serviceCatalog','Saved service','',[['','Choose a service'],...state.services.filter(s=>search(state.draftServiceFilter,[s.description,s.code,s.hsn])).map(s=>[s.id,`${s.description} · ${s.unitPrice||'0'} INR`])]);
}
function servicePicker() {
  return `<div class="service-picker"><div class="panel-list">${searchBox('draftServiceSearch',state.draftServiceFilter,'Find a saved service')}<div id="service-picker-options">${serviceOptions()}</div></div>${btn('apply-service','Add service','','','plus')}</div>`;
}
function serviceRows() {
  const rows=state.services.filter(s=>search(state.serviceFilter,[s.description,s.code,s.hsn]));
  if(!rows.length)return `<div class="empty">${icon('box')}<h2>${state.serviceFilter?'No matching services':'Your service catalogue starts here'}</h2><p>Save the descriptions, rates and units you use often, then add them to invoices.</p></div>`;
  return `<div class="table-wrap"><table><thead><tr><th>Service</th><th>HSN / SAC</th><th>Unit price</th><th>GST</th><th>Actions</th></tr></thead><tbody>${rows.map(s=>`<tr><td><strong>${e(s.description)}</strong><br><small>${e(s.code)}</small></td><td>${e(s.hsn)}</td><td>${e(s.unitPrice||'0')} INR / ${e(s.unit)}</td><td>${e(s.gstRate||'0')}%</td><td><div class="actions">${btn('edit-service','Edit','',`data-id="${e(s.id)}"`)}${btn('delete-service','Delete','subtle danger',`data-id="${e(s.id)}"`)}</div></td></tr>`).join('')}</tbody></table></div>`;
}
function servicesView() {
  return heading('Services','Keep the services and items you invoice regularly in one place.',btn('new-service','New service','primary','','plus'),'Service catalogue')+
    `<section class="card"><div class="listbar">${searchBox('serviceSearch',state.serviceFilter,'Search services by name or HSN')}</div><div id="service-rows">${serviceRows()}</div></section>`;
}
function serviceView() {
  const s=state.service;
  return heading(s.id?'Edit service':'New service','Choose your usual rates. You can adjust them on an individual invoice.',btn('cancel-service','Cancel')+btn('save-service','Save service','primary','','save'),'Service catalogue')+
    `<div id="service-form">${section('Service details',`<div class="grid">${[['code','Item code'],['description','Description'],['hsn','HSN / SAC'],['unit','Unit / UQC'],['unitPrice','Unit price (₹)'],['gstRate','GST %'],['cessRate','Cess %']].map(([key,label])=>field(key,label,s[key],'text',['unitPrice','gstRate','cessRate'].includes(key)?'inputmode="decimal" maxlength="18"':'maxlength="220"')).join('')}</div>`)}</div>`;
}
function newPayment(row) {
  return {id:crypto.randomUUID(),amount:((row.balance??row.total)/100).toFixed(2),date:today(),method:'Bank transfer',reference:'',note:''};
}
function paymentsView() {
  const row=state.invoices.find(r=>r.id===state.paymentInvoice);
  if(!row)return heading('Payments','This invoice is unavailable.',btn('nav','Back to invoices','', 'data-id="invoices"'));
  const p=state.paymentForm;
  const cards=[['Invoice total',row.total],['Received',row.paid??0],['Outstanding',row.balance??row.total]];
  return heading(`Payments · ${e(row.number)}`,`${e(row.buyer)}${row.dueDate?' · Due '+e(displayDate(row.dueDate)):''}`,btn('nav','Back to invoices','','data-id="invoices"'),'Payment records')+
    `<div class="stats">${cards.map(([label,value])=>`<div class="card stat"><span class="k">${label}</span><strong>${amount(value)}</strong></div>`).join('')}</div>`+
    section('Record a received payment',`<p class="notice">Check your bank or payment app before recording a payment. A scanned QR by itself does not confirm receipt.</p><div id="payment-form" class="grid">${field('amount','Received amount (₹)',p.amount,'text','inputmode="decimal"')+field('date','Payment date',p.date,'date')+select('method','Payment method',p.method,['UPI','Bank transfer','Cash','Other'].map(v=>[v,v]))+field('reference','Transaction reference',p.reference,'text','maxlength="200"')+field('note','Payment note',p.note,'textarea','maxlength="1000"')}</div>`,btn('record-payment','Record payment','primary',row.balance===0?'disabled':''))+
    section('Payment history',state.payments.length?`<div class="table-wrap"><table><thead><tr><th>Date</th><th>Amount</th><th>Method</th><th>Reference</th><th>Action</th></tr></thead><tbody>${state.payments.map(p=>`<tr><td>${e(displayDate(p.date))}</td><td class="money">${amount(p.paise)}</td><td>${e(p.method)}</td><td>${e(p.reference)||'—'}</td><td>${btn('delete-payment','Remove','subtle danger',`data-id="${e(p.id)}"`)}</td></tr>`).join('')}</tbody></table></div>`:'<p class="muted">Received payments will appear here.</p>');
}
function helpView() {
  const last=state.info.lastBackup?new Date(state.info.lastBackup).toLocaleString():'Create your first workspace backup';
  return heading('Help & about','Tools to keep Invoicer In ready for your business.','','Invoicer In')+
    `<div class="panel-list">${section('Invoicer In',`<p>Version <strong>${e(state.info.version??'')}</strong></p><p>Built by <strong>Kelly Label Studio</strong> with an invoicing workflow developed for SSKT Logistics.</p><p class="muted">We share this open-source Windows app to help Indian small businesses create, reuse and manage GST invoices. The source uses the MIT licence.</p>`,btn('project-page','Source code','','data-id="source"')+btn('project-page','Updates & release notes','','data-id="updates"'))}
    ${section('Start menu',`<p>Refresh the app shortcut for this Windows account and open its folder. You can right-click the shortcut and choose <strong>Pin to Start</strong>.</p><p class="muted">Windows manages the pinned area and search results.</p>`,btn('repair-shortcut','Refresh Start menu shortcut'))}
    ${section('Workspace backup',`<p>Last successful backup</p><strong>${e(last)}</strong><p class="muted">Backups include invoices, PDFs, customers, services and payment records. Restore checks the file and saves a safety copy of your current workspace.</p>${state.note?`<p class="notice">${e(state.note)}</p>`:''}`,btn('backup','Create backup')+btn('restore','Restore backup','subtle'))}
    ${section('Keyboard shortcuts',`<div class="shortcut-list"><p><kbd>Ctrl</kbd> + <kbd>N</kbd> New invoice</p><p><kbd>Ctrl</kbd> + <kbd>S</kbd> Save the current form</p><p><kbd>Ctrl</kbd> + <kbd>K</kbd> Focus search</p><p><kbd>Ctrl</kbd> + <kbd>Enter</kbd> Review and issue an invoice</p></div>`)}</div>`;
}
function validateDraftFields() {
  const d=state.draft;
  const errors={};
  if(!/^[a-z0-9/-]{1,16}$/i.test(d.number??''))errors.number='Use 1–16 letters, numbers, hyphens or slashes.';
  if(!d.date)errors.date='Choose an invoice date.';
  if(d.dueDate&&d.dueDate<d.date)errors.dueDate='Choose a date on or after the invoice date.';
  if(!d.placeOfSupplyCode)errors.placeOfSupplyCode='Choose the place of supply.';
  if(!d.buyer?.name?.trim())errors['buyer.name']='Enter the buyer name.';
  if(!d.buyer?.address?.trim())errors['buyer.address']='Enter the billing address.';
  if(!d.buyer?.state?.trim())errors['buyer.state']='Enter the state or union territory.';
  if(!/^\d{2}$/.test(d.buyer?.stateCode??''))errors['buyer.stateCode']='Enter the two-digit state code.';
  for(const [i,item] of d.items.entries()) {
    if(!item.description?.trim())errors[`items.${i}.description`]='Add a service or item description.';
    if(!/^\d+(\.\d{1,3})?$/.test(item.quantity??'')||Number(item.quantity)<=0)errors[`items.${i}.quantity`]='Use a quantity greater than zero.';
    if(!item.hsn?.trim())errors[`items.${i}.hsn`]='Add the HSN or SAC code.';
    if(!item.unitPrice?.trim()||!/^\d+(\.\d{1,2})?$/.test(item.unitPrice))errors[`items.${i}.unitPrice`]='Enter a price with up to two decimal places.';
  }
  state.fieldErrors=errors;
  if(!Object.keys(errors).length){state.issueError='';return true;}
  const first=Object.keys(errors)[0];
  state.editorTab=first.startsWith('buyer.')?'customer':first.startsWith('items.')?'items':'details';
  state.panel='form';state.issueError='Check the highlighted fields before issuing this invoice.';render();
  root.querySelector(`[name="${first}"]`)?.focus();
  return false;
}
function showDraftError(message) {
  const line=message.match(/^Line (\d+): (quantity|unitPrice|discount|gstRate|cessRate)/);
  if(line){state.fieldErrors[`items.${Number(line[1])-1}.${line[2]}`]=message;state.editorTab='items';state.panel='form';}
}
async function businessAction(action,id,button) {
  if(action==='setup-step') {
    state.view='settings';render();
    const name={supplier:'seller.name',tax:'irp',payment:'payment.upiId'}[id];
    root.querySelector(`[name="${name}"]`)?.focus();
  } else if(action==='new-service'||action==='edit-service'||action==='save-line-service') {
    state.serviceFromDraft=action==='save-line-service';
    state.service=action==='edit-service'?clone(state.services.find(s=>s.id===id)):
      action==='save-line-service'?clone(state.draft.items[Number(id)]):emptyLine();
    if(action==='save-line-service'){delete state.service.id;await persistDraft();}
    state.view='service';render();
  } else if(action==='cancel-service') {
    state.view=state.serviceFromDraft?'draft':'services';render();
  } else if(action==='save-service') {
    button.disabled=true;
    try {await invoke('save_service',{value:state.service});state.services=await invoke('list_services');state.view=state.serviceFromDraft?'draft':'services';render();notify('Service saved.');}
    finally {button.disabled=false;}
  } else if(action==='delete-service') {
    if(!await confirm('Delete this saved service?','Invoices already issued keep their saved line items.','Delete service'))return true;
    await invoke('delete_service',{id});state.services=await invoke('list_services');render();
  } else if(action==='apply-service') {
    const id=root.querySelector('[name=serviceCatalog]').value;
    const service=state.services.find(s=>s.id===id);
    if(!service)throw Error('Choose a saved service first.');
    if(state.draft.items.length>=250)throw Error('An invoice supports up to 250 lines.');
    const item={...clone(service),quantity:'1'};delete item.id;
    const empty=state.draft.items.findIndex(line=>!line.description&&!line.unitPrice);
    if(empty>=0)state.draft.items[empty]=item;else state.draft.items.push(item);
    queueDraft();render();
  } else if(action==='payments') {
    state.paymentInvoice=id;state.payments=await invoke('list_payments',{invoice:id});
    state.paymentForm=newPayment(state.invoices.find(r=>r.id===id));state.view='payments';render();
  } else if(action==='record-payment'||action==='delete-payment') {
    if(action==='delete-payment'&&!await confirm('Remove this payment record?','The outstanding amount will be recalculated. This only changes your local payment record.','Remove payment'))return true;
    state.locked=true;button.disabled=true;
    try {
      if(action==='record-payment')await invoke('save_payment',{invoice:state.paymentInvoice,value:state.paymentForm});
      else await invoke('delete_payment',{invoice:state.paymentInvoice,id});
      await refresh();state.payments=await invoke('list_payments',{invoice:state.paymentInvoice});
      state.paymentForm=newPayment(state.invoices.find(r=>r.id===state.paymentInvoice));render();notify('Payment records updated.');
    } finally {state.locked=false;button.disabled=false;}
  } else if(action==='restore') {
    if(!await confirm('Restore this workspace from a backup?','The selected backup will replace the invoices, contacts, services and payments on this PC. A safety copy is saved first. Google Drive uploads are paused after restore.','Choose backup'))return true;
    state.locked=true;button.disabled=true;
    try {
      await draftWrite;
      const safety=await invoke('restore_backup');
      if(safety){await refresh();state.draft=await invoke('get_draft');state.note=`Backup restored. Your previous workspace is saved at ${safety}.`;state.view='help';render();notify('Workspace restored.');}
    } finally {state.locked=false;button.disabled=false;}
  } else if(action==='project-page') {
    await invoke('open_project_page',{page:id});
  } else if(action==='repair-shortcut') {
    button.disabled=true;
    try {await invoke('repair_start_menu');notify('Shortcut refreshed. Right-click Invoicer In in the opened folder and choose Pin to Start.');}
    finally {button.disabled=false;}
  } else return false;
  return true;
}

document.addEventListener('keydown',event=>{
  if(!(event.ctrlKey||event.metaKey)||event.altKey||modal.open||state.locked)return;
  const key=event.key.toLowerCase();
  if(key==='s'&&document.activeElement?.matches('[data-accent-control]')) {
    const input=document.activeElement;
    if(!setAccentColor(input.dataset.accentControl,input.value)) {
      event.preventDefault();input.setAttribute('aria-invalid','true');notify('Enter a color such as #086e66.',true);return;
    }
  }
  let button;
  if(key==='n'){event.preventDefault();openDraft().catch(error=>notify(error.message??error,true));return;}
  if(key==='s')button=root.querySelector(`[data-action="${({draft:'save-draft',settings:'save-settings',contact:'save-customer',service:'save-service'})[state.view]}"]`);
  if(key==='k'){event.preventDefault();root.querySelector('input[type=search]')?.focus();return;}
  if(key==='enter'&&state.view==='draft')button=root.querySelector('[data-action="issue"]');
  if(button){event.preventDefault();button.click();}
});
