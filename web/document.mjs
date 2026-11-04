import { freightPages, freightTemplate, paymentQrPayload } from './freight.mjs';
export { freightTemplate, paymentQrPayload };

const pageA4 = { width: 841.89, height: 595.28 };
const block = (label, x, y, w, h, size, border = true) => ({ label, x, y, w, h, size, color: '#141414', border });
export const defaultTemplate = {
  ...pageA4,
  blocks: {
    seller: block('Supplier', 28, 23, 455, 75, 9, false),
    heading: block('Tax invoice', 496, 23, 168, 34, 15, false),
    pageNumber: block('Page number', 496, 63, 168, 26, 9, false),
    logo: block('Logo', 675, 23, 137, 75, 9, false),
    headerRule: block('Header rule', 28, 101, 784, 2, 8),
    details: block('Invoice details', 28, 107, 784, 43, 9),
    buyer: block('Bill to', 28, 160, 385, 90, 9),
    shipping: block('Ship to', 427, 160, 385, 90, 9),
    logistics: block('Shipment details', 28, 260, 784, 47, 8),
    items: block('Line items', 28, 317, 784, 110, 8),
    notes: block('Notes', 28, 437, 354, 115, 8),
    totals: block('Totals', 392, 437, 274, 115, 9),
    qr: block('Invoice summary QR', 676, 437, 136, 115, 8, false),
    footerRule: block('Footer rule', 28, 556, 784, 2, 8),
    footer: block('Authorised signatory', 635, 561, 177, 19, 8, false)
  }
};
export const templateSections = template => Object.keys((template.kind === 'freight' ? freightTemplate : defaultTemplate).blocks)
  .filter(key => key!=='totals' || template.kind!=='freight' || template.blocks?.totals);

export function clone(value) { return structuredClone(value); }
export const amount = (paise = 0) => new Intl.NumberFormat('en-IN', {
  style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2
}).format(paise / 100);
export const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, c =>
  ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]);
export const displayDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value ?? '') ? value.split('-').reverse().join('/') : value ?? '';
export const validLogo = value => typeof value === 'string' && /^data:image\/(?:png|jpeg);base64,[a-zA-Z0-9+/]+=*$/.test(value);

export function resizePaper(template, width, height) {
  const next = clone(template);
  const sx = width / next.width;
  const sy = height / next.height;
  for (const item of Object.values(next.blocks)) {
    for (const [key, factor] of Object.entries({x:sx,y:sy,w:sx,h:sy})) item[key] = Math.round(item[key] * factor * 10) / 10;
    item.size = Math.round(Math.max(5, Math.min(28, item.size * Math.min(sx, sy))) * 10) / 10;
  }
  return { ...next, width, height };
}

export function checkTemplate(template) {
  if (!Number.isFinite(template.width) || !Number.isFinite(template.height) ||
      [template.width, template.height].some(n => n < 300 || n > 1800)) {
    throw new Error('Paper dimensions must be between 300 and 1,800 points.');
  }
  const sections = templateSections(template);
  for (const key of sections) {
    const box = template.blocks?.[key];
    if (!box || [box.x, box.y, box.w, box.h, box.size].some(n => !Number.isFinite(n)) ||
        box.x < 0 || box.y < 0 || box.w < 25 || box.h < (key.endsWith('Rule') ? 1 : template.kind === 'freight' ? 8 : 14) ||
        box.x + box.w > template.width + 0.01 || box.y + box.h > template.height + 0.01 ||
        box.size < 5 || box.size > 28 || !/^#[0-9a-f]{6}$/i.test(box.color) || ![undefined,'left','center','right'].includes(box.align)) {
      throw new Error(`Check the position, size, and color of the ${key} section.`);
    }
  }
  for (const [i, key] of sections.entries()) {
    const a = template.blocks[key];
    for (const other of sections.slice(i + 1)) {
      const b = template.blocks[other];
      if (a.x < b.x + b.w - 0.1 && b.x < a.x + a.w - 0.1 && a.y < b.y + b.h - 0.1 && b.y < a.y + a.h - 0.1) {
        throw new Error(`“${a.label}” overlaps “${b.label}”. Move or resize a section.`);
      }
    }
  }
}

function wrap(value, width, size, measure) {
  if (!value) return [];
  return String(value).split(/\r?\n/).flatMap(line => {
    if (!line) return [''];
    const lines = [];
    let rest = line;
    while (measure(rest, size) > width) {
      const chars = Array.from(rest);
      let hi = chars.length;
      let lo = 1;
      while (lo < hi) {
        const middle = Math.ceil((lo + hi) / 2);
        if (measure(chars.slice(0, middle).join(''), size) <= width) lo = middle;
        else hi = middle - 1;
      }
      let cut = chars.slice(0, lo).join('');
      const space = cut.lastIndexOf(' ');
      if (space > 0) cut = cut.slice(0, space);
      lines.push(cut);
      rest = rest.slice(cut.length).trimStart();
    }
    return [...lines, rest];
  });
}

function indianWords(value) {
  const small = 'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split(' ');
  const tens = 'zero ten twenty thirty forty fifty sixty seventy eighty ninety'.split(' ');
  const upto100 = n => n < 20 ? small[n] : tens[Math.floor(n / 10)] + (n % 10 ? ' ' + small[n % 10] : '');
  let rupees = Math.floor(value / 100);
  const output = [];
  for (const [unit, label] of [[10_000_000, 'crore'], [100_000, 'lakh'], [1000, 'thousand'], [100, 'hundred']]) {
    if (rupees < unit) continue;
    const count = Math.floor(rupees / unit);
    output.push((count < 100 ? upto100(count) : indianWords(count * 100).split(' rupees')[0]) + ' ' + label);
    rupees %= unit;
  }
  if (rupees || !output.length) output.push(upto100(rupees));
  const paise = value % 100;
  return output.join(' ') + ' rupees' + (paise ? ' and ' + upto100(paise) + ' paise' : '') + ' only';
}

function party(data = {}) {
  return [data.name, data.address, data.address2, [data.state, data.stateCode].filter(Boolean).join(' · '),
    data.gstin && `GSTIN ${data.gstin}`, [data.email, data.phone].filter(Boolean).join(' · ')].filter(Boolean);
}

export function documentPages(data, quote, template, qr, measure, { strict = false, paymentQr } = {}) {
  if (strict) checkTemplate(template);
  if (template.kind === 'freight') {
    return freightPages(data, quote, template, qr, paymentQr, measure, strict, {wrap,amount,indianWords,displayDate,validLogo});
  }
  const b = template.blocks;
  const split = data.regime !== 'igst';
  const taxLabel = data.regime === 'utgst' ? 'UTGST' : 'SGST';
  const columns = [
    ['#', .035], ['Description', .205], ['HSN/SAC', .084], ['Qty / unit', .090],
    ['Unit price', .092], ['Discount', .081], ['Taxable', .089],
    [split ? 'CGST' : 'IGST', split ? .081 : .137], ...(split ? [[taxLabel,.081]] : []),
    ['Cess', .075], ['Total', split ? .087 : .112]
  ];
  const sumWidth = columns.reduce((n, c) => n + c[1], 0);
  const widths = columns.map(([, portion]) => b.items.w * portion / sumWidth);
  const size = b.items.size;
  const lineHeight = size * 1.24;
  const rowData = (data.items ?? []).map((row, i) => {
    const m = quote.lines[i] ?? {};
    const gst = Number(row.gstRate || 0);
    const cells = [
      String(i + 1), row.description, row.hsn, `${row.quantity ?? ''} ${row.unit ?? ''}`.trim(),
      amount(Math.round(Number(row.unitPrice || 0) * 100)),
      amount(Math.round(Number(row.discount || 0) * 100)), amount(m.taxable),
      split ? `${gst / 2}% · ${amount(m.cgst)}` : `${gst}% · ${amount(m.igst)}`,
      ...(split ? [`${gst / 2}% · ${amount(m.sgst)}`] : []),
      `${row.cessRate || 0}% · ${amount(m.cess)}`, amount(m.total)
    ];
    const lines = cells.map((v, c) => wrap(v, widths[c] - 7, size, measure));
    return { lines, height: Math.max(lineHeight, ...lines.map(v => v.length * lineHeight)) + 8 };
  });
  const headerLines = columns.map(([name], c) => wrap(name, widths[c] - 7, size, measure));
  const headerHeight = Math.max(...headerLines.map(v => v.length), 1) * lineHeight + 8;
  const sectionTitleHeight = lineHeight + 7;
  const capacity = b.items.h - headerHeight - sectionTitleHeight;
  if (capacity < lineHeight + 8) throw new Error('Make the line-items section taller so it can fit a row.');
  const chunks = [[]];
  let used = 0;
  for (const row of rowData) {
    if (row.height > capacity) {
      if (strict) throw new Error('A line item exceeds the table height. Shorten it or enlarge the line-items section.');
      row.height = capacity;
    }
    if (used + row.height > capacity) { chunks.push([]); used = 0; }
    chunks.at(-1).push(row);
    used += row.height;
  }

  const pageCount = chunks.length;
  return chunks.map((rows, pageIndex) => {
    const final = pageIndex === pageCount - 1;
    const ops = [];
    const rect = (x,y,w,h, fill, stroke) => ops.push({ type:'rect', x,y,w,h,fill,stroke });
    const text = (x,y,value,size,color) => { if (value) ops.push({type:'text',x,y,value,size,color}); };
    const rule = (x,y,w,h,color) => ops.push({type:'line', x,y,x2:x+w,y2:y+h,color});
    const frame = box => { if (box.border) rect(box.x,box.y,box.w,box.h,null,'#96a3b4'); };
    const paragraph = (box, title, body) => {
      frame(box);
      const height = box.size * 1.25;
      const lines = [title, ...body].filter(Boolean).flatMap(v => wrap(v, box.w - 14, box.size, measure));
      const max = Math.floor((box.h - 8) / height);
      if (strict && lines.length > max) throw new Error(`“${box.label}” has too much text for its section. Enlarge it or shorten its content.`);
      lines.slice(0, Math.max(0, max)).forEach((line, i) => text(box.x+7, box.y+box.size+4+i*height,line,box.size,box.color));
    };

    const seller = data.seller ?? {};
    paragraph(b.seller, '', [seller.name, seller.tagline, seller.address,
      [seller.gstin && `GSTIN ${seller.gstin}`,seller.state,seller.stateCode].filter(Boolean).join(' · '),
      seller.website].filter(Boolean));
    paragraph(b.heading, b.heading.label, []);
    paragraph(b.pageNumber, '', [`Page ${pageIndex + 1} of ${pageCount}`]);
    if (b.headerRule.border) rect(b.headerRule.x,b.headerRule.y,b.headerRule.w,b.headerRule.h,b.headerRule.color,null);
    frame(b.logo);
    if (validLogo(data.seller?.logo)) ops.push({type:'image',x:b.logo.x+4,y:b.logo.y+4,w:b.logo.w-8,h:b.logo.h-8,value:data.seller.logo});
    paragraph(b.details, b.details.label, [
      [`Invoice ${data.number || '—'}`, displayDate(data.date),
        data.placeOfSupply && `Place of supply: ${data.placeOfSupply} (${data.placeOfSupplyCode})`,
        data.reverseCharge ? 'Reverse charge: Yes' : 'Reverse charge: No'].filter(Boolean).join('     |     ')
    ]);
    paragraph(b.buyer, b.buyer.label, party(data.buyer));
    paragraph(b.shipping, b.shipping.label, party(data.ship).length ? party(data.ship) : ['Same as billing address']);
    paragraph(b.logistics, b.logistics.label, [
      [data.orderDate && 'Order date: ' + displayDate(data.orderDate), data.order && `Order: ${data.order}`, data.journey && `Journey: ${data.journey}`, data.origin && `From: ${data.origin}`,
        data.destination && `To: ${data.destination}`, data.container && `Container: ${data.container}`,
        data.containerSize && `Size: ${data.containerSize}`, data.containerType && `Type: ${data.containerType}`,
        data.containerStatus && `Status: ${data.containerStatus}`].filter(Boolean).join('    |    ')
    ]);

    frame(b.items);
    text(b.items.x+5,b.items.y+size+3,b.items.label,size,b.items.color);
    let y = b.items.y + sectionTitleHeight;
    rect(b.items.x,y,b.items.w,headerHeight,'#eaf0f7',null);
    const drawCells = (cells, height) => {
      let x = b.items.x;
      for (let col = 0; col < cells.length; col++) {
        cells[col].slice(0, Math.floor((height-5)/lineHeight)).forEach((line,index) =>
          text(x+3,y+size+4+index*lineHeight,line,size,b.items.color));
        if (col) rule(x,y,0,height,'#d9e1ec');
        x += widths[col];
      }
      y += height;
      rule(b.items.x,y,b.items.w,0,'#d9e1ec');
    };
    drawCells(headerLines,headerHeight);
    for (const row of rows) drawCells(row.lines,row.height);

    if (final) {
      const t = quote.totals;
      const notes = [
        data.irn && `IRN: ${data.irn}`,
        data.paymentTerms && `Payment terms: ${data.paymentTerms}`,
        data.transactionType && `Transaction: ${data.transactionType}`,
        data.insurance && `Insurance by: ${data.insurance}`, data.notes,
        t.total > 0 && indianWords(t.total)
      ];
      paragraph(b.notes, b.notes.label, notes.filter(Boolean));
      paragraph(b.totals, b.totals.label, [
        `Taxable value: ${amount(t.taxable)}`,
        ...(split ? [`CGST: ${amount(t.cgst)}`, `${taxLabel}: ${amount(t.sgst)}`] : [`IGST: ${amount(t.igst)}`]),
        ...(t.cess ? [`Cess: ${amount(t.cess)}`] : []),
        `Invoice total: ${amount(t.total)}`
      ]);
      frame(b.qr);
      const label = data.signedQr ? 'Official IRP signed QR' : b.qr.label;
      const labelWidth = measure(label,b.qr.size);
      if (strict && labelWidth > b.qr.w - 8) throw new Error('Enlarge the QR section so its label fits.');
      text(b.qr.x+Math.max(4,(b.qr.w-labelWidth)/2), b.qr.y+b.qr.size+2, label, b.qr.size, b.qr.color);
      if (qr?.length) {
        const side = Math.min(b.qr.w-8,b.qr.h-b.qr.size-7);
        if (strict && side < 85) throw new Error('Enlarge the QR section to keep its code scannable.');
        ops.push({ type:'qr', x:b.qr.x+(b.qr.w-side)/2, y:b.qr.y+b.qr.size+6, w:side, h:side, value:qr });
      }
    }
    if (b.footerRule.border) rect(b.footerRule.x,b.footerRule.y,b.footerRule.w,b.footerRule.h,b.footerRule.color,null);
    paragraph(b.footer,b.footer.label,[]);
    return ops;
  });
}

function qrRuns(matrix, cell, x, y, callback) {
  matrix.forEach((row, line) => {
    for (let start = 0; start < row.length;) {
      if (!row[start]) { start++; continue; }
      let end = start + 1;
      while (row[end]) end++;
      callback(x + (start+4)*cell, y+(line+4)*cell, (end-start)*cell, cell);
      start = end;
    }
  });
}

export function toSvg(template, ops, editor = false, selected = '', snap = false) {
  const out = [`<svg viewBox="0 0 ${template.width} ${template.height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Invoice page preview">`,
    `<rect width="100%" height="100%" fill="white"/>`];
  for (const o of ops) {
    if (o.type === 'text') out.push(`<text x="${o.x}" y="${o.y}" font-family="Invoice Sans, sans-serif" font-size="${o.size}" font-weight="${o.style==='bold'?'bold':'normal'}" font-style="${o.style==='italic'?'italic':'normal'}" fill="${o.color}">${escapeHtml(o.value)}</text>`);
    if (o.type === 'rect') out.push(`<rect x="${o.x}" y="${o.y}" width="${o.w}" height="${o.h}" fill="${o.fill ?? 'none'}" stroke="${o.stroke ?? 'none'}" stroke-width=".65"/>`);
    if (o.type === 'line') out.push(`<line x1="${o.x}" y1="${o.y}" x2="${o.x2}" y2="${o.y2}" stroke="${o.color}" stroke-width=".65"/>`);
    if (o.type === 'image') out.push(`<image x="${o.x}" y="${o.y}" width="${o.w}" height="${o.h}" href="${o.value}"/>`);
    if (o.type === 'qr') {
      const path = [];
      qrRuns(o.value,o.w/(o.value.length+8),o.x,o.y,(x,y,w,h) => path.push(`M${x} ${y}h${w}v${h}h-${w}z`));
      out.push(`<path d="${path.join(' ')}" fill="#000"/>`);
    }
  }
  if (editor && snap) {
    out.push('<defs><pattern id="layout-grid" width="4" height="4" patternUnits="userSpaceOnUse"><path d="M4 0H0V4" fill="none" stroke="#638fbd" stroke-width=".25"/></pattern></defs><rect width="100%" height="100%" fill="url(#layout-grid)" opacity=".35" pointer-events="none"/>');
  }
  if (editor) for (const key of templateSections(template)) {
    const b = template.blocks[key];
    const active = key === selected;
    out.push(`<rect class="layout-box" data-section="${key}" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="${active ? '#c9e0ff50' : 'transparent'}" stroke="${active ? '#075ec7' : '#678fbd'}" stroke-width="${active ? 2 : 1}" stroke-dasharray="${active ? 'none' : '4 3'}"/>`);
  }
  if (editor && selected && template.blocks[selected]) {
    const b = template.blocks[selected];
    out.push(`<rect class="layout-handle" data-section="${selected}" data-resize="true" x="${b.x+b.w-7}" y="${b.y+b.h-7}" width="10" height="10" rx="1" fill="#075ec7"/>`);
  }
  out.push('</svg>');
  return out.join('');
}

const rgbValues = hex => [1,3,5].map(i => parseInt(hex.slice(i,i+2),16)/255);
export async function makePdf({ pdfLib, fontkit, fontBytes, data, quote, template, qr, paymentQr }) {
  const { PDFDocument, rgb } = pdfLib;
  const color = hex => rgb(...rgbValues(hex));
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(fontBytes, {subset:true});
  const styles = template.kind==='freight' ? {
    bold:await pdf.embedFont(pdfLib.StandardFonts.HelveticaBold),
    italic:await pdf.embedFont(pdfLib.StandardFonts.HelveticaOblique)
  } : {};
  const face=(value,style)=>styles[style] && /^[\u0020-\u007e\u00a0-\u00ff]*$/.test(value) ? styles[style] : font;
  const pages = documentPages(data, quote, template, qr, (value, size, style) => face(value,style).widthOfTextAtSize(value,size), {strict:true,paymentQr});
  const logo = data.seller?.logo;
  const image = validLogo(logo)
    ? await (logo.startsWith('data:image/png;') ? pdf.embedPng(logo) : pdf.embedJpg(logo)) : null;
  for (const ops of pages) {
    const page = pdf.addPage([template.width,template.height]);
    const fy = y => template.height-y;
    for (const o of ops) {
      if (o.type === 'text') page.drawText(o.value,{x:o.x,y:fy(o.y),font:face(o.value,o.style),size:o.size,color:color(o.color)});
      if (o.type === 'line') page.drawLine({start:{x:o.x,y:fy(o.y)},end:{x:o.x2,y:fy(o.y2)},color:color(o.color),thickness:.65});
      if (o.type === 'rect') page.drawRectangle({x:o.x,y:fy(o.y+o.h),width:o.w,height:o.h,
        ...(o.fill ? {color:color(o.fill)} : {}), ...(o.stroke ? {borderColor:color(o.stroke),borderWidth:.65} : {})});
      if (o.type === 'image' && image) {
        const box = image.scaleToFit(o.w,o.h);
        page.drawImage(image,{x:o.x+(o.w-box.width)/2,y:fy(o.y+(o.h+box.height)/2),...box});
      }
      if (o.type === 'qr') qrRuns(o.value,o.w/(o.value.length+8),o.x,o.y,(x,y,w,h) =>
        page.drawRectangle({x,y:fy(y+h),width:w,height:h,color:rgb(0,0,0)}));
    }
  }
  pdf.setTitle(`Tax invoice ${data.number}`);
  pdf.setProducer('Invoicer-in');
  return pdf.save();
}

export function qrPayload(data, totals) {
  return data.signedQr?.trim() || `GST INVOICE SUMMARY\nInvoice: ${data.number || 'Draft'}\nDate: ${displayDate(data.date)}\nTotal: INR ${((totals.total ?? 0)/100).toFixed(2)}`;
}

export function csvRegister(rows) {
  const cell = value => {
    let raw = String(value ?? '');
    if (/^\s*[=+\-@]|\r|\n/.test(raw)) raw = "'" + raw;
    return '"' + raw.replaceAll('"','""') + '"';
  };
  const lines = rows.map(row => [row.number,row.day,row.buyer,(row.total/100).toFixed(2)]);
  return '\ufeff' + [['Invoice','Date','Buyer','Total (INR)'],...lines].map(r => r.map(cell).join(',')).join('\r\n');
}
