const box = (label, x, y, w, h, size = 8, extra = {}) =>
  ({ label, x, y, w, h, size, color: '#171717', border: false, ...extra });

const fields = [
  ['sellerStateCode','State Code',62,107,136], ['sellerState','State Name',206,107,141],
  ['sellerPan','PAN',62,117,136], ['sellerGstin','GSTIN',206,117,190],
  ['invoiceNumber','Invoice No',62,148,136], ['invoiceDate','Invoice Date',206,148,133],
  ['orderNumber','Order No',346,148,131], ['orderDate','Order Date',484,148,123],
  ['journey','Journey No',62,160,136], ['origin','From',206,160,133],
  ['destination','To',346,160,131], ['reverseCharge','Reverse Charge',484,160,123],
  ['rruNumber','RRU No',62,172,136], ['rruSize','RRU Size (FT)',206,172,133],
  ['rruType','RRU Type',346,172,131], ['rruStatus','RRU Status (L/E)',206,184,250],
  ['supply','Place Of Supply',62,196,438]
];

export const freightTemplate = {
  kind: 'freight',
  width: 792, height: 612,
  blocks: {
    seller: box('Company name',62,18,538,25,21,{color:'#082a3a'}),
    tagline: box('Tagline',62,47,538,15,11,{color:'#082a3a'}),
    logo: box('Logo',688,9,49,53),
    headerRule: box('Header rule',58,69,689,1,7,{border:true}),
    pageNumber: box('Page number',604,72,138,10,7,{align:'right'}),
    recipient: box('ORIGINAL FOR RECIPIENT',596,84,146,10,7,{align:'right'}),
    heading: box('TAX INVOICE',302,91,180,14,11,{align:'center'}),
    sender: box('Sender Details',62,96,235,9,8),
    ...Object.fromEntries(fields.map(([key,label,x,y,w]) => [key, box(label,x,y,w,9,7.5)])),
    qr: box('Invoice QR',611,101,127,128,7),
    buyer: box('Name Of Buyer',57,243,338,51,7,{border:true}),
    shipping: box('Shipped/Dispatch To',395,243,360,51,7,{border:true}),
    items: box('Line items',58,308,696,77,7,{border:true}),
    notes: box('Notes and totals in words',62,386,593,63,7.5),
    paymentQr: box('Bank payment details',663,387,77,71,7),
    end: box('--- End Of Invoice ---',250,456,284,13,9,{align:'center'}),
    printDate: box('Print Date',61,522,330,11,7.5),
    footerRule: box('Footer rule',58,535,696,1,7,{border:true}),
    footer: box('Registered address and signature',58,537,696,42,7.5,{border:true})
  },
  columns: {}
};

const common = [['number','Sr. No.',.049],['description','Item Code & Description',.238],
  ['hsn','HSN / SAC Code',.071],['quantity','Quantity / UOM',.071],['price','Unit Price (Rs.)',.080],
  ['taxable','Taxable Value (Rs.)',.091]];
export const freightColumns = [...common, ['cgstRate','CGST %',.059],['cgstValue','CGST Value (Rs.)',.071],
  ['sgstRate','SGST %',.061],['sgstValue','SGST Value (Rs.)',.070],['igstRate','IGST %',.120],['igstValue','IGST Value (Rs.)',.141],
  ['cessRate','CESS %',.049],['cessValue','CESS Value (Rs.)',.081]];

function partyLines(label, party = {}) {
  const [first, ...rest] = (party.address || '').split(/\r?\n/);
  return [
    [label, party.name], ['Address Line 1', first], ['Address Line 2', [party.address2, ...rest].filter(Boolean).join(' ')],
    ['PAN', party.pan], ['GSTIN', party.gstin],
    ['State Code-Name', [party.stateCode,party.state].filter(Boolean).join(' · ')]
  ].map(([name,value]) => `${name}: ${value || ''}`);
}

export function paymentQrPayload(payment) {
  if (!payment || !['holder','bank','account','ifsc'].every(key => typeof payment[key] === 'string' && payment[key].trim())) return '';
  return ['BANK TRANSFER DETAILS', `Account holder: ${payment.holder.trim()}`, `Bank: ${payment.bank.trim()}`,
    `Account number: ${payment.account.trim()}`, `IFSC: ${payment.ifsc.trim().toUpperCase()}`,
    payment.branch?.trim() && `Branch: ${payment.branch.trim()}`].filter(Boolean).join('\n');
}

export function freightPages(data, quote, template, qr, paymentQr, measure, strict, helpers) {
  const { wrap, amount, indianWords, displayDate, validLogo } = helpers;
  const b = template.blocks;
  const seller = data.seller ?? {};
  const split = data.regime !== 'igst';
  const subTax = data.regime === 'utgst' ? 'UTGST' : 'SGST';
  const number = new Intl.NumberFormat('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2});
  const money = paise => number.format((paise || 0) / 100);
  const columnKeys = split ? ['cgstRate','cgstValue','sgstRate','sgstValue'] : ['igstRate','igstValue'];
  const columns = freightColumns.filter(([key]) => !/^(?:cgst|sgst|igst)/.test(key) || columnKeys.includes(key));
  const portions = columns.map(([key,,fallback]) => Number(template.columns?.[key]) || fallback * 100);
  const totalPortions = portions.reduce((sum, v) => sum + v, 0);
  const widths = portions.map(v => b.items.w * v / totalPortions);
  const size = b.items.size;
  const leading = size * 1.22;
  const headings = columns.map(([,label], i) => wrap(label.replace('SGST',subTax),widths[i]-5,size,measure));
  const headerHeight = Math.max(1,...headings.map(lines=>lines.length))*leading + 5;
  const totalsHeight = 31;
  const capacity = b.items.h - headerHeight;
  const finalCapacity = capacity - totalsHeight;
  if (finalCapacity < leading + 5) throw new Error('The item table needs room for a row and the totals.');
  const rows = (data.items ?? []).map((item,i) => {
    const values = quote.lines[i] ?? {};
    const gst = Number(item.gstRate || 0);
    const cells = [String(i+1),[item.code,item.description].filter(Boolean).join(' · '),item.hsn,
      [item.quantity,item.unit].filter(Boolean).join(' '),money(Math.round(Number(item.unitPrice || 0)*100)),money(values.taxable),
      ...(split ? [`${gst/2}%`,money(values.cgst),`${gst/2}%`,money(values.sgst)] : [`${gst}%`,money(values.igst)]),
      `${item.cessRate || 0}%`,money(values.cess)];
    const lines=cells.map((v,c)=>wrap(v,widths[c]-5,size,measure));
    const height=Math.max(1,...lines.map(v=>v.length))*leading+5;
    if (strict && height>finalCapacity) throw new Error('An item is too tall for the table. Enlarge the table or shorten the item.');
    return {lines,height:Math.min(height,finalCapacity)};
  });
  const pages=[[]];
  let used=0;
  for(const row of rows) {
    if(used+row.height>capacity) { pages.push([]); used=0; }
    pages.at(-1).push(row);
    used+=row.height;
  }
  if(used>finalCapacity) {
    const previous=pages.at(-1);
    let moved=0;
    let start=previous.length;
    while(start>0 && moved+previous[start-1].height<=finalCapacity) moved+=previous[--start].height;
    pages.push(previous.splice(start));
  }

  return pages.map((page,index)=>{
    const final=index===pages.length-1;
    const ops=[];
    const ink='#242424';
    const rect=(x,y,w,h,fill=null,stroke=ink)=>ops.push({type:'rect',x,y,w,h,fill,stroke});
    const line=(x,y,x2,y2)=>ops.push({type:'line',x,y,x2,y2,color:ink});
    const text=(x,y,value,size,color=ink)=>{if(value) ops.push({type:'text',x,y,value,size,color});};
    function section(box,values,{ padding=0, label=box.label }={}) {
      const gap=box.size*1.14;
      const content=values.flatMap(value=>wrap(value,box.w-padding*2,box.size,measure));
      const max=Math.floor((box.h-padding)/gap+0.06);
      if(strict && content.length>max) throw new Error(`“${label}” needs more room. Enlarge the field or shorten the text.`);
      content.slice(0,max).forEach((value,i)=>{
        const remaining=box.w-padding*2-measure(value,box.size);
        const shift=box.align==='center'?remaining/2:box.align==='right'?remaining:0;
        text(box.x+padding+Math.max(0,shift),box.y+padding+box.size+i*gap,value,box.size,box.color);
      });
    }
    const single=(key,value)=>section(b[key],[value]);
    const field=(key,value)=>single(key,`${b[key].label}: ${value ?? ''}`);
    function qrBox(box,matrix,label,minSize) {
      if(!matrix?.length)return;
      const side=Math.min(box.w,box.h-box.size-2);
      if(strict && (side<minSize || measure(label,box.size)>box.w)) throw new Error(`Enlarge the ${label} area so the code and label fit.`);
      ops.push({type:'qr',x:box.x+(box.w-side)/2,y:box.y,w:side,h:side,value:matrix});
      text(box.x+Math.max(0,(box.w-measure(label,box.size))/2),box.y+side+box.size+1,label,box.size,box.color);
    }

    single('seller',seller.name);
    single('tagline',seller.tagline);
    if(validLogo(seller.logo))ops.push({type:'image',x:b.logo.x,y:b.logo.y,w:b.logo.w,h:b.logo.h,value:seller.logo});
    for(const key of ['headerRule','footerRule']) if(b[key].border)rect(b[key].x,b[key].y,b[key].w,b[key].h,b[key].color,null);
    single('pageNumber',`Page ${index+1} of ${pages.length}`);
    single('recipient',b.recipient.label);
    single('heading',b.heading.label);
    single('sender',b.sender.label+':');
    field('sellerStateCode',seller.stateCode || seller.gstin?.slice(0,2));field('sellerState',seller.state);
    field('sellerPan',seller.pan);field('sellerGstin',seller.gstin);
    field('invoiceNumber',data.number);field('invoiceDate',displayDate(data.date));
    field('orderNumber',data.order);field('orderDate',displayDate(data.orderDate));
    field('journey',data.journey);field('origin',data.origin);field('destination',data.destination);
    field('reverseCharge',data.reverseCharge?'Yes':'No');
    field('rruNumber',data.container);field('rruSize',data.containerSize);field('rruType',data.containerType);
    field('rruStatus',data.containerStatus);
    field('supply',[data.placeOfSupplyCode,data.placeOfSupply].filter(Boolean).join(' · '));
    qrBox(b.qr,qr,data.signedQr?'Official IRP signed QR':b.qr.label,85);

    for(const [key,party] of [['buyer',data.buyer],['shipping',data.ship?.address?data.ship:data.buyer]]) {
      const block=b[key];
      if(block.border) rect(block.x,block.y,block.w,block.h);
      section(block,partyLines(block.label,party),{padding:3});
    }

    let y=b.items.y;
    function tableRow(cells,height) {
      let x=b.items.x;
      for(const [col,lines] of cells.entries()) {
        if(col)line(x,y,x,y+height);
        for(const [i,value] of lines.slice(0,Math.floor((height-3)/leading)).entries()) text(x+2.5,y+size+2+i*leading,value,size,b.items.color);
        x+=widths[col];
      }
      y+=height;
      line(b.items.x,y,b.items.x+b.items.w,y);
    }
    tableRow(headings,headerHeight);
    for(const row of page)tableRow(row.lines,row.height);
    if(final) {
      const t=quote.totals;
      const totals=[['Total Taxable Value',t.taxable],['Total GST Value',(t.cgst||0)+(t.sgst||0)+(t.igst||0)+(t.cess||0)],['Total Invoice Value',t.total]];
      const splitX=b.items.x+b.items.w*.83;
      for(const [label,value] of totals) {
        const rowHeight=totalsHeight/3;
        const width=measure(label,size);
        text(splitX-width-5,y+size+1,label,size,b.items.color);
        text(splitX+5,y+size+1,money(value),size,b.items.color);
        line(splitX,y,splitX,y+rowHeight);
        y+=rowHeight;
        line(b.items.x,y,b.items.x+b.items.w,y);
      }
      const notes=[`Total Rs: ${amount(t.total)}`,`Total in words Rs: ${indianWords(t.total)}`,
        data.notes&&`Note: ${data.notes}`,data.transactionType&&`Transaction Type: ${data.transactionType}`,
        data.paymentTerms&&`Payment Term: ${data.paymentTerms}`,data.insurance&&`Insurance By: ${data.insurance}`,
        data.irn&&`IRN: ${data.irn}`].filter(Boolean);
      section(b.notes,notes);
      qrBox(b.paymentQr,paymentQr,b.paymentQr.label,55);
      single('end',b.end.label);
    }
    if(b.items.border)rect(b.items.x,b.items.y,b.items.w,y-b.items.y);
    field('printDate',displayDate(data.printDate || data.date));
    const footer=b.footer;
    const first=footer.x+footer.w*.44;
    const second=footer.x+footer.w*.73;
    if(footer.border) {
      line(footer.x,footer.y+footer.h,footer.x+footer.w,footer.y+footer.h);
      line(first,footer.y,first,footer.y+footer.h);line(second,footer.y,second,footer.y+footer.h);
    }
    section({...footer,x:first+5,w:second-first-10},[seller.address?`Address: ${seller.address}`:'Address:']);
    section({...footer,x:second+4,w:footer.x+footer.w-second-8,y:footer.y+footer.h-footer.size-3,h:footer.size+3,align:'center'},['Authorised Signatory']);
    return ops;
  });
}
