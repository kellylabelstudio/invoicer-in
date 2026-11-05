const box = (label, x, y, w, h, size = 8, extra = {}) =>
  ({ label, x, y, w, h, size, color: '#171717', border: false, ...extra });

const fields = [
  ['sellerStateCode','State Code',24,96,150], ['sellerState','State Name',186,96,156],
  ['sellerPan','PAN',24,108,150], ['sellerGstin','GSTIN',186,108,156],
  ['invoiceNumber','Invoice No',24,132,150], ['invoiceDate','Invoice Date',186,132,156],
  ['orderNumber','Order No',349,132,150], ['orderDate','Order Date',511,132,156],
  ['journey','Journey No',24,151,150], ['origin','From',186,151,156],
  ['destination','To',349,151,150], ['reverseCharge','Reverse Charge',511,151,156],
  ['rruNumber','Container No',24,170,150], ['rruSize','Container Size(FT)',186,170,156],
  ['rruType','Container Type',349,170,150], ['supply','Place Of Supply',511,170,156],
  ['rruStatus','Container Status (L/E)',186,189,156]
];

export const freightTemplate = {
  kind: 'freight',
  width: 792, height: 612,
  blocks: {
    seller: box('Company name',24,31,490,19,15,{color:'#00655b',style:'bold'}),
    tagline: box('Tagline',24,52,490,11,8,{style:'italic'}),
    logo: box('Logo',654,28,111,45),
    headerRule: box('Header rule',23,75,743,1,7,{border:true}),
    pageNumber: box('Page number',627,76,138,8,6.5,{align:'right'}),
    recipient: box('ORIGINAL FOR RECIPIENT',611,85,154,9,7,{align:'right',style:'bold'}),
    heading: box('TAX INVOICE',306,78,176,16,13,{align:'center',style:'bold'}),
    sender: box('Sender Details',24,82,235,11,8,{style:'bold'}),
    ...Object.fromEntries(fields.map(([key,label,x,y,w]) => [key, box(label,x,y,w,10,6.3)])),
    qr: box('Invoice QR',678,125,88,88,7,{showLabel:false}),
    buyer: box('Name Of Buyer',23,218,368,69,6.8,{border:true}),
    shipping: box('Shipped/Dispatch To',394,218,368,69,6.8,{border:true}),
    items: box('Line items',23,304,743,53,6.1,{border:true}),
    totals: box('Tax totals',452,357,314,31,6.6,{border:true}),
    notes: box('Notes and totals in words',23,363,418,74,7),
    paymentQr: box('Bank payment details',670,395,85,73,7),
    end: box('--- End Of Invoice ---',250,484,292,11,7.5,{align:'center',style:'bold'}),
    footerRule: box('Footer rule',23,499,743,1,7,{border:true}),
    printDate: box('Print Date',23,502,330,9,6.7),
    footer: box('Registered office and signature',23,513,743,34,6.6)
  },
  columns: {}
};

const common = [['number','Sr. No.',.036],['description','Item Code & Description',.341],
  ['hsn','HSN/ SAC\nCode',.064],['quantity','Quantity\nUOM',.055],['price','Unit Price\n(Rs.)',.082],
  ['taxable','Taxable Value\n(Rs.)',.083]];
export const freightColumns = [...common, ['cgstRate','CGST %',.040],['cgstValue','CGST\nValue (Rs.)',.076],
  ['sgstRate','SGST %',.040],['sgstValue','SGST\nValue (Rs.)',.074],['igstRate','IGST %',.080],['igstValue','IGST\nValue (Rs.)',.150],
  ['cessRate','CESS %',.038],['cessValue','CESS\nValue (Rs.)',.075]];

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
  const ruled = Boolean(b.totals);
  const leading = size * (ruled ? 1.14 : 1.22);
  const headings = columns.map(([,label], i) => wrap(label.replace('SGST',subTax),widths[i]-5,size,
    (value, fontSize) => measure(value, fontSize, ruled ? 'bold' : undefined)));
  const headerHeight = Math.max(1,...headings.map(lines=>lines.length))*leading + (ruled ? 2.5 : 5);
  const totalsHeight = 31;
  const capacity = b.items.h - headerHeight;
  const finalCapacity = ruled ? capacity : capacity - totalsHeight;
  if (finalCapacity < leading + 5) throw new Error('The item table needs room for a row and the totals.');
  const rows = (data.items ?? []).map((item,i) => {
    const values = quote.lines[i] ?? {};
    const gst = Number(item.gstRate || 0);
    const cells = [String(i+1),[item.code,item.description].filter(Boolean).join(' · '),item.hsn,
      [item.quantity,item.unit].filter(Boolean).join(' '),money(Math.round(Number(item.unitPrice || 0)*100)),money(values.taxable),
      ...(split ? [`${gst/2}%`,money(values.cgst),`${gst/2}%`,money(values.sgst)] : [`${gst}%`,money(values.igst)]),
      `${item.cessRate || 0}%`,money(values.cess)];
    const lines=cells.map((v,c)=>wrap(v,widths[c]-5,size,measure));
    const height=Math.max(1,...lines.map(v=>v.length))*leading+(ruled?4:5);
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
    const text=(x,y,value,size,color=ink,style)=>{if(value) ops.push({type:'text',x,y,value,size,color,style});};
    function section(box,values,{ padding=0, label=box.label }={}) {
      const gap=box.size*1.14;
      const width=(value,size)=>measure(value,size,box.style);
      const content=values.flatMap(value=>wrap(value,box.w-padding*2,box.size,width));
      const max=Math.floor((box.h-padding)/gap+0.06);
      if(strict && content.length>max) throw new Error(`“${label}” needs more room. Enlarge the field or shorten the text.`);
      content.slice(0,max).forEach((value,i)=>{
        const remaining=box.w-padding*2-width(value,box.size);
        const shift=box.align==='center'?remaining/2:box.align==='right'?remaining:0;
        text(box.x+padding+Math.max(0,shift),box.y+padding+box.size+i*gap,value,box.size,box.color,box.style);
      });
    }
    const single=(key,value)=>section(b[key],[value]);
    const field=(key,value)=>{
      const box=b[key];
      const label=box.label+':';
      const width=measure(label+' ',box.size,'bold');
      if(!ruled || width+measure(value || '',box.size)>box.w) {
        single(key,`${label} ${value ?? ''}`);
        return;
      }
      text(box.x,box.y+box.size,label,box.size,box.color,'bold');
      text(box.x+width,box.y+box.size,value,box.size,box.color);
    };
    function qrBox(box,matrix,label,minSize) {
      if(!matrix?.length)return;
      const caption=box.showLabel!==false;
      const side=Math.min(box.w,box.h-(caption?box.size+2:0));
      if(strict && (side<minSize || (caption&&measure(label,box.size)>box.w))) throw new Error(`Enlarge the ${label} area so the code and label fit.`);
      ops.push({type:'qr',x:box.x+(box.w-side)/2,y:box.y,w:side,h:side,value:matrix});
      if(caption)text(box.x+Math.max(0,(box.w-measure(label,box.size))/2),box.y+side+box.size+1,label,box.size,box.color);
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
      const values=partyLines(block.label,party);
      if(!ruled) {
        section(block,values,{padding:3});
        continue;
      }
      const rowLeading=block.size*1.15;
      const rows=values.map((value,i)=>wrap(value,block.w-6,block.size,
        (value,size)=>measure(value,size,i===0?'bold':undefined)));
      const contentHeight=rows.reduce((sum,row)=>sum+Math.max(1,row.length)*rowLeading,0);
      if(strict&&contentHeight>block.h-rows.length) throw new Error(`“${block.label}” needs more room. Enlarge the box or shorten the address.`);
      const padding=Math.max(1,(block.h-contentHeight)/rows.length);
      let y=block.y;
      for(const [i,row] of rows.entries()) {
        if(y+block.size>block.y+block.h)break;
        for(const [j,value] of row.entries()) {
          const baseline=y+block.size+padding/2+j*rowLeading;
          if(baseline<block.y+block.h)text(block.x+3,baseline,value,block.size,block.color,i===0?'bold':undefined);
        }
        y+=Math.max(1,row.length)*rowLeading+padding;
        if(block.border&&i<rows.length-1&&y<block.y+block.h)line(block.x,y,block.x+block.w,y);
      }
    }

    let y=b.items.y;
    function tableRow(cells,height,header=false) {
      let x=b.items.x;
      for(const [col,lines] of cells.entries()) {
        if(col)line(x,y,x,y+height);
        const style=header&&ruled?'bold':undefined;
        const align=ruled?(header?'center':col===1?'left':'right'):'left';
        for(const [i,value] of lines.slice(0,Math.floor((height-(ruled?1:3))/leading)).entries()) {
          const remaining=Math.max(0,widths[col]-5-measure(value,size,style));
          const shift=align==='center'?remaining/2:align==='right'?remaining:0;
          text(x+2.5+shift,y+size+(ruled?1:2)+i*leading,value,size,b.items.color,style);
        }
        x+=widths[col];
      }
      y+=height;
      line(b.items.x,y,b.items.x+b.items.w,y);
    }
    if(ruled)rect(b.items.x,y,b.items.w,headerHeight,'#e2ebe8',null);
    tableRow(headings,headerHeight,true);
    for(const row of page)tableRow(row.lines,row.height);
    if(ruled) {
      const gap=b.items.y+b.items.h-y;
      const blanks=Math.min(Math.max(1,3-page.length),Math.max(1,Math.floor(gap/(leading+2))));
      if(gap>.05)for(let i=0;i<blanks;i++)tableRow(columns.map(()=>[]),gap/blanks);
    }
    const tableEnd=y;
    if(final) {
      const t=quote.totals;
      const totals=[['Total Taxable Value',t.taxable],['Total GST Value',(t.cgst||0)+(t.sgst||0)+(t.igst||0)+(t.cess||0)],['Total Invoice Value',t.total]];
      const box=b.totals;
      if(box) {
        const height=box.h/totals.length;
        if(strict&&height<box.size+2) throw new Error('Enlarge the tax totals box so all three rows fit.');
        if(box.border)rect(box.x,box.y,box.w,box.h);
        for(const [i,[label,value]] of totals.entries()) {
          const top=box.y+i*height;
          const baseline=top+(height+box.size)/2-1;
          const numeric=money(value);
          text(box.x+3,baseline,label+':',box.size,box.color,'bold');
          text(box.x+box.w-3-measure(numeric,box.size,'bold'),baseline,numeric,box.size,box.color,'bold');
          if(i&&box.border)line(box.x,top,box.x+box.w,top);
        }
      } else {
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
      }
      const notes=[`Total Rs: ${ruled?money(t.total):amount(t.total)}`,`Total in words Rs: ${indianWords(t.total)}`,
        data.transactionType&&`Transaction Type: ${data.transactionType}`,
        data.paymentTerms&&`Payment Term: ${data.paymentTerms}`,data.notes&&`Note: ${data.notes}`,
        data.insurance&&`Insurance By: ${data.insurance}`,data.irn&&`IRN: ${data.irn}`].filter(Boolean);
      section(b.notes,notes);
      qrBox(b.paymentQr,paymentQr,b.paymentQr.label,55);
      single('end',b.end.label);
    }
    if(b.items.border)rect(b.items.x,b.items.y,b.items.w,(ruled?tableEnd:y)-b.items.y);
    field('printDate',displayDate(data.printDate || data.date));
    const footer=b.footer;
    if(ruled) {
      const labelWidth=72;
      const rightWidth=152;
      const details=[['Registered Office',seller.address],['Website',seller.website],['GSTIN',seller.gstin]];
      const gap=footer.size*1.2;
      const available=footer.w-rightWidth-labelWidth-12;
      let rowY=footer.y;
      for(const [label,value] of details) {
        const lines=wrap(value,available,footer.size,measure);
        const height=Math.max(1,lines.length)*gap;
        if(strict&&rowY+height>footer.y+footer.h+.1) throw new Error('The registered office footer needs more room.');
        text(footer.x,rowY+footer.size,label+':',footer.size,footer.color,'bold');
        for(const [i,part] of lines.entries())text(footer.x+labelWidth,rowY+footer.size+i*gap,part,footer.size,footer.color);
        rowY+=height;
      }
      const right={...footer,x:footer.x+footer.w-rightWidth,w:rightWidth,align:'right'};
      if(seller.name)section({...right,style:'bold'},[`For ${seller.name}`]);
      section({...right,y:footer.y+footer.h-gap,h:gap},['Authorised Signatory']);
      return ops;
    }
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
