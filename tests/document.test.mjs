import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import { checkTemplate, clone, csvRegister, defaultTemplate, documentPages, makePdf, qrPayload, resizePaper, toSvg } from '../web/document.mjs';

const require = createRequire(import.meta.url);
const pdfLib = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const fontBytes = await readFile(new URL('../web/assets/DejaVuSans.ttf',import.meta.url));

const item={description:'Domestic freight service',hsn:'996511',quantity:'2',unit:'NOS',unitPrice:'1000',gstRate:'18',cessRate:'0'};
const line={taxable:200000,cgst:18000,sgst:18000,igst:0,cess:0,total:236000};
const data={number:'INV-0024',date:'2026-11-04',regime:'split',placeOfSupply:'Maharashtra',placeOfSupplyCode:'27',
  seller:{name:'Example Freight Studio',tagline:'Delivery with care.',address:'12 Sample Lane, Pune 411001',gstin:'27ABCDE1234F1Z5'},
  buyer:{name:'Harbour Demo Works',address:'41 Sample Road, Mumbai 400001',state:'Maharashtra',stateCode:'27',gstin:'27AAAAA1111A1Z5'},
  ship:{name:'Harbour Receiving',address:'7 Example Lane, Mumbai 400001'},
  items:[item],origin:'Pune',destination:'Mumbai',container:'DEMO 001',notes:'Thank you for your business.'};
const quote={lines:[line],totals:line};
const qr=Array.from({length:21},(_,y)=>Array.from({length:21},(_,x)=>(x+y)%3===0));
const measure=(value,size)=>value.length*size*.53;

test('default and resized paper layouts keep sections inside the page',()=>{
  checkTemplate(defaultTemplate);
  checkTemplate(resizePaper(defaultTemplate,720,650));
  const invalid=clone(defaultTemplate);
  invalid.blocks.items.y=120;
  assert.throws(()=>checkTemplate(invalid),/overlaps/);
});

test('long invoices paginate with every item and page numbering',()=>{
  const items=Array.from({length:18},(_,i)=>({...item,description:'Freight service '+(i+1)}));
  const pages=documentPages({...data,items},{lines:items.map(()=>line),totals:line},defaultTemplate,qr,measure,{strict:true});
  assert.ok(pages.length>1);
  for(let i=1;i<=18;i++) {
    assert.ok(pages.flat().some(o=>o.value==='Freight service '+i), 'missing item '+i);
  }
  assert.equal(pages.flat().filter(o=>o.type==='qr').length,1);
  assert.ok(pages.at(-1).some(o=>o.value==='Page '+pages.length+' of '+pages.length));
});

test('preview escapes SVG markup and refuses clipped print sections',()=>{
  const buyer={...data.buyer,name:'<img src=x onerror=alert(1)>'};
  const ops=documentPages({...data,buyer},quote,defaultTemplate,qr,measure)[0];
  const svg=toSvg(defaultTemplate,ops,true,'buyer');
  assert.match(svg,/&lt;img/);
  assert.doesNotMatch(svg,/<img /);
  assert.match(svg,/data-section="buyer"/);
  assert.throws(()=>documentPages({...data,buyer:{...buyer,address:'Long address\n'.repeat(30)}},
    quote,defaultTemplate,qr,measure,{strict:true}),/too much text/);
});

test('offline QR omits customer contact details and an IRP payload takes precedence',()=>{
  const summary=qrPayload(data,quote.totals);
  assert.match(summary,/INR 2360\.00/);
  assert.doesNotMatch(summary,/Harbour|ABCDE/);
  assert.equal(qrPayload({...data,signedQr:'aaa.bbb.ccc'},quote.totals),'aaa.bbb.ccc');
});

test('register CSV quotes cells and neutralizes spreadsheet formulas',()=>{
  const csv=csvRegister([{number:'INV-1',day:'2026-11-04',buyer:'=HYPERLINK("example")',total:1000}]);
  assert.match(csv,/"'=HYPERLINK\(""example""\)"/);
  assert.match(csv,/"10\.00"/);
});

test('PDF renderer produces a readable landscape PDF',async()=>{
  const bytes=await makePdf({pdfLib,fontkit,fontBytes,data,quote,template:defaultTemplate,qr});
  const pdf=await pdfLib.PDFDocument.load(bytes);
  assert.equal(pdf.getPageCount(),1);
  assert.equal(pdf.getTitle(),'Tax invoice INV-0024');
  assert.equal(pdf.getPage(0).getWidth(),defaultTemplate.width);
  if(process.env.INVOICE_SAMPLE_PDF) await writeFile(process.env.INVOICE_SAMPLE_PDF,bytes);
});

test('freight layout keeps the invoice QR above the parties and bank QR optional',async()=>{
  const {freightTemplate,paymentQrPayload}=await import('../web/document.mjs');
  checkTemplate(freightTemplate);
  const plain=documentPages(data,quote,freightTemplate,qr,measure,{strict:true})[0];
  assert.equal(plain.filter(o=>o.type==='qr').length,1);
  assert.ok(plain.some(o=>o.value==='Container No:'));
  assert.ok(plain.some(o=>o.value==='Registered Office:'));
  assert.ok(plain.some(o=>o.value==='For Example Freight Studio'));
  assert.ok(plain.some(o=>o.value==='Delivery with care.' && o.style==='italic'));
  assert.ok(plain.some(o=>o.type==='rect' && o.fill==='#e2ebe8'));
  assert.ok(plain.some(o=>o.type==='line' && o.x===freightTemplate.blocks.buyer.x &&
    o.x2===freightTemplate.blocks.buyer.x+freightTemplate.blocks.buyer.w && o.y>freightTemplate.blocks.buyer.y));
  assert.ok(plain.some(o=>o.type==='rect' && o.x===freightTemplate.blocks.totals.x && o.y===freightTemplate.blocks.totals.y));
  const bank={holder:'Example Supplier',bank:'Demo Bank',account:'00001234',ifsc:'demo0000001'};
  assert.match(paymentQrPayload(bank),/Account number: 00001234/);
  assert.match(paymentQrPayload(bank),/IFSC: DEMO0000001/);
  assert.equal(paymentQrPayload({...bank,ifsc:''}),'');
  const printed=documentPages(data,quote,freightTemplate,qr,measure,{strict:true,paymentQr:qr})[0];
  const [main,payment]=printed.filter(o=>o.type==='qr');
  assert.ok(main.y<freightTemplate.blocks.buyer.y);
  assert.ok(payment.y>freightTemplate.blocks.items.y);
  assert.ok(printed.some(o=>o.value==='Bank payment details'));
  const bytes=await makePdf({pdfLib,fontkit,fontBytes,data,quote,template:freightTemplate,qr,paymentQr:qr});
  const pdf=await pdfLib.PDFDocument.load(bytes);
  assert.equal(pdf.getPageCount(),1);
  assert.equal(pdf.getPage(0).getWidth(),792);
  if(process.env.INVOICER_FREIGHT_PDF) await writeFile(process.env.INVOICER_FREIGHT_PDF,bytes);
});

test('freight pages keep every row and print the totals only on the final page',async()=>{
  const {freightTemplate}=await import('../web/document.mjs');
  const items=Array.from({length:17},(_,i)=>({...item,description:'Freight item '+(i+1)}));
  const pages=documentPages({...data,items},{lines:items.map(()=>line),totals:line},freightTemplate,qr,measure,{strict:true,paymentQr:qr});
  assert.ok(pages.length>1);
  assert.equal(pages.flat().filter(o=>o.value?.startsWith?.('Freight item ')).length,17);
  assert.equal(pages.flat().filter(o=>o.value==='Total Invoice Value:').length,1);
  assert.ok(pages.at(-1).some(o=>o.value==='Total Invoice Value:'));
  assert.equal(pages.flat().filter(o=>o.value==='Bank payment details').length,1);
});
