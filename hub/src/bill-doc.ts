import { HubError } from './hub.ts';

/**
 * A bill as the customer gets it on WhatsApp (src/whatsapp-bills.ts): what the POS printed, already worked out by the
 * POS (the POS bill stays the legal record; nothing is calculated here). DinePOS and quickPOS send it with
 * POST /v1/pos/bills/:code/whatsapp, and inside their bill.printed sync events (payload.share) for the bill's QR code.
 * Money is integer paise. Shown as a page (/b/:code) and as a PDF (/b/:code.pdf, the WhatsApp attachment).
 */
export interface BillDoc {
  store: { name: string; address?: string; phone?: string; gstin?: string; fssai?: string };
  /** "Tax invoice", "Bill of supply", … (default "Bill") */
  title?: string;
  billNo: string;
  /** ISO time the bill was issued */
  issuedAt: string;
  /** "Table 4", "Takeaway", "Delivery", … */
  orderLabel?: string;
  lines: Array<{ name: string; /** as printed: "2", "0.5 kg" */ qty: string; amountPaise: number }>;
  /** subtotal, discount (negative), each tax, charges, round off: as printed, in order */
  summary: Array<{ label: string; amountPaise: number }>;
  totalPaise: number;
  payments?: Array<{ mode: string; amountPaise: number }>;
  footer?: string;
}

const str = (v: unknown, max: number, field: string, required = true): string | undefined => {
  if (v !== undefined && v !== null && typeof v !== 'string') throw new HubError('VALIDATION', `The bill's ${field} is not text.`, 400, { fields: { [field]: 'Not text.' } });
  // control characters out, except new lines (an address or footer may have them)
  const s = typeof v === 'string' ? v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
  if (!s && required) throw new HubError('VALIDATION', `The bill has no ${field}.`, 400, { fields: { [field]: 'Missing.' } });
  return s || undefined;
};
const paise = (v: unknown, field: string): number => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || Math.abs(v) > 1e12) throw new HubError('VALIDATION', `The bill's ${field} is not an amount in paise.`, 400, { fields: { [field]: 'Not paise.' } });
  return v;
};
const list = (v: unknown, max: number, field: string): unknown[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > max) throw new HubError('VALIDATION', `The bill's ${field} is not a list (at most ${max}).`, 400);
  return v;
};
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});

/** Checks a bill from a POS and keeps only the known fields (cut to sensible lengths). */
export function checkBillDoc(input: unknown): BillDoc {
  const b = obj(input), s = obj(b.store);
  const issuedAt = str(b.issuedAt, 40, 'issuedAt')!;
  if (Number.isNaN(Date.parse(issuedAt))) throw new HubError('VALIDATION', 'The bill time is not a date.', 400, { fields: { issuedAt: 'Not a date.' } });
  const doc: BillDoc = {
    store: { name: str(s.name, 120, 'store name')!, address: str(s.address, 300, 'store address', false), phone: str(s.phone, 40, 'store phone', false), gstin: str(s.gstin, 20, 'GSTIN', false), fssai: str(s.fssai, 20, 'FSSAI', false) },
    title: str(b.title, 40, 'title', false),
    billNo: str(b.billNo, 40, 'bill number')!,
    issuedAt,
    orderLabel: str(b.orderLabel, 60, 'order label', false),
    lines: list(b.lines, 500, 'lines').map((l, i) => { const o = obj(l); return { name: str(o.name, 120, `line ${i + 1} name`)!, qty: str(String(o.qty ?? ''), 20, `line ${i + 1} quantity`, false) ?? '', amountPaise: paise(o.amountPaise, `line ${i + 1} amount`) }; }),
    summary: list(b.summary, 40, 'summary').map((l, i) => { const o = obj(l); return { label: str(o.label, 60, `summary ${i + 1} label`)!, amountPaise: paise(o.amountPaise, `summary ${i + 1} amount`) }; }),
    totalPaise: paise(b.totalPaise, 'total'),
    payments: list(b.payments, 20, 'payments').map((l, i) => { const o = obj(l); return { mode: str(o.mode, 40, `payment ${i + 1} mode`)!, amountPaise: paise(o.amountPaise, `payment ${i + 1} amount`) }; }),
    footer: str(b.footer, 400, 'footer', false),
  };
  if (doc.lines.length === 0) throw new HubError('VALIDATION', 'The bill has no items.', 400, { fields: { lines: 'No items.' } });
  return doc;
}

/** 84000 → "840.00", -2500 → "-25.00" (Indian grouping: 1,23,456.00). */
export function rupees(p: number): string {
  const neg = p < 0, a = Math.abs(p), whole = String(Math.floor(a / 100)), frac = String(a % 100).padStart(2, '0');
  const grouped = whole.length > 3 ? `${whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${whole.slice(-3)}` : whole;
  return `${neg ? '-' : ''}${grouped}.${frac}`;
}

/** The bill's time in India: "22-11-2026 14:05". */
export function billTime(iso: string): string {
  const d = new Date(Date.parse(iso) + 5.5 * 3_600_000).toISOString();
  return `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)} ${d.slice(11, 16)}`;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The bill page (/b/:code): the bill as printed, a PDF download and a print button. No scripts. */
export function billHtml(doc: BillDoc, pdfHref: string): string {
  const row = (a: string, b: string, cls = '') => `<tr class="${cls}"><td>${a}</td><td class="r">${b}</td></tr>`;
  const s = doc.store;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(s.name)}: bill ${esc(doc.billNo)}</title>
<style>
:root{color-scheme:light dark;--bg:#f4f1ea;--paper:#fff;--ink:#1d1b18;--muted:#6b665d;--line:#ddd6c8;--accent:#1f7a4d}
@media (prefers-color-scheme:dark){:root{--bg:#141311;--paper:#1f1d1a;--ink:#ece8e0;--muted:#a29c90;--line:#3a3630;--accent:#4cc38a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px 16px}
.bill{max-width:420px;margin:0 auto;background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:22px 20px}
h1{font-size:19px;margin:0;text-align:center}.c{text-align:center}.m{color:var(--muted);font-size:13px}
.meta{display:flex;justify-content:space-between;gap:8px;margin:14px 0 6px;font-size:13px;color:var(--muted)}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}td{padding:5px 0;vertical-align:top}.r{text-align:right;white-space:nowrap;padding-left:10px}
.items td{border-bottom:1px dashed var(--line)}.q{color:var(--muted);font-size:13px}
.sum td{padding:3px 0;font-size:14px}.total td{font-weight:700;font-size:18px;border-top:2px solid var(--ink);padding-top:9px}
.pay td{color:var(--muted);font-size:13px}.foot{margin-top:16px;text-align:center;color:var(--muted);font-size:13px;white-space:pre-line}
.actions{max-width:420px;margin:16px auto 0;display:flex;gap:10px}.actions a{flex:1;text-align:center;padding:11px;border-radius:10px;text-decoration:none;font-weight:600;border:1px solid var(--line);color:var(--ink);background:var(--paper)}
.actions a.p{background:var(--accent);border-color:var(--accent);color:#fff}
@media print{body{background:#fff;padding:0}.bill{border:0}.actions{display:none}}
</style></head><body>
<main class="bill">
<h1>${esc(s.name)}</h1>
${s.address ? `<div class="c m">${esc(s.address)}</div>` : ''}
${[s.phone ? `Phone ${esc(s.phone)}` : '', s.gstin ? `GSTIN ${esc(s.gstin)}` : '', s.fssai ? `FSSAI ${esc(s.fssai)}` : ''].filter(Boolean).map((t) => `<div class="c m">${t}</div>`).join('')}
<div class="c" style="margin-top:10px;font-weight:600">${esc(doc.title || 'Bill')}</div>
<div class="meta"><span>Bill ${esc(doc.billNo)}${doc.orderLabel ? ` · ${esc(doc.orderLabel)}` : ''}</span><span>${esc(billTime(doc.issuedAt))}</span></div>
<table class="items">${doc.lines.map((l) => row(`${esc(l.name)}${l.qty ? ` <span class="q">× ${esc(l.qty)}</span>` : ''}`, rupees(l.amountPaise))).join('')}</table>
<table class="sum" style="margin-top:8px">${doc.summary.map((x) => row(esc(x.label), rupees(x.amountPaise))).join('')}
${row('Total', `₹${rupees(doc.totalPaise)}`, 'total')}
${(doc.payments ?? []).map((p) => row(`Paid by ${esc(p.mode)}`, rupees(p.amountPaise), 'pay')).join('')}</table>
${doc.footer ? `<div class="foot">${esc(doc.footer)}</div>` : ''}
</main>
<div class="actions"><a class="p" href="${esc(pdfHref)}" download>Download PDF</a></div>
</body></html>`;
}

// ---------------------------------------------------------------- PDF (one receipt-width page, Courier)

const COLS = 42;
/** PDF text: the PDF's own fonts only have Latin-1, so ₹ is "Rs." and other scripts become "?". */
const latin = (s: string) => s.replace(/₹/g, 'Rs.').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/[^ -~ -ÿ]/g, '?');

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of latin(text).split(/\n/)) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      for (let w = word; w; ) {
        const room = width - (line ? line.length + 1 : 0);
        if (w.length <= room) { line = line ? `${line} ${w}` : w; w = ''; }
        else if (!line) { out.push(w.slice(0, width)); w = w.slice(width); }
        else { out.push(line); line = ''; }
      }
    }
    out.push(line);
  }
  return out;
}
const centre = (s: string) => ' '.repeat(Math.max(0, Math.floor((COLS - s.length) / 2))) + s;
const pair = (left: string, right: string) => {
  const r = latin(right), l = wrap(left, COLS - r.length - 1);
  const last = l.pop() ?? '';
  return [...l, last + ' '.repeat(Math.max(1, COLS - last.length - r.length)) + r];
};

/** The bill as receipt text lines (42 columns); bold: lines drawn in bold. */
export function billLines(doc: BillDoc): Array<{ text: string; bold?: boolean }> {
  const L: Array<{ text: string; bold?: boolean }> = [];
  const add = (lines: string[], bold = false) => { for (const text of lines) L.push({ text, bold }); };
  const rule = () => add(['-'.repeat(COLS)]);
  const s = doc.store;
  add(wrap(s.name, COLS).map(centre), true);
  if (s.address) add(wrap(s.address, COLS).map(centre));
  for (const t of [s.phone ? `Phone ${s.phone}` : '', s.gstin ? `GSTIN ${s.gstin}` : '', s.fssai ? `FSSAI ${s.fssai}` : '']) if (t) add(wrap(t, COLS).map(centre));
  add([''], false);
  add([centre(latin(doc.title || 'Bill'))], true);
  rule();
  add(pair(`Bill ${doc.billNo}`, billTime(doc.issuedAt)));
  if (doc.orderLabel) add(wrap(doc.orderLabel, COLS));
  rule();
  for (const l of doc.lines) add(pair(l.qty ? `${l.name} x ${l.qty}` : l.name, rupees(l.amountPaise)));
  rule();
  for (const x of doc.summary) add(pair(x.label, rupees(x.amountPaise)));
  add(pair('TOTAL', `Rs. ${rupees(doc.totalPaise)}`), true);
  for (const p of doc.payments ?? []) add(pair(`Paid by ${p.mode}`, rupees(p.amountPaise)));
  if (doc.footer) { rule(); add(wrap(doc.footer, COLS).map(centre)); }
  return L;
}

const pdfStr = (s: string) => `(${s.replace(/[\\()]/g, (c) => `\\${c}`)})`;

/** The bill as a one-page PDF, 80 mm wide like a printed bill (no fonts embedded: Courier is in every PDF reader). */
export function billPdf(doc: BillDoc): Buffer {
  const lines = billLines(doc);
  const size = 8, lead = 10.5, margin = 14, width = 228;
  const height = Math.ceil(margin * 2 + lines.length * lead);
  let y = height - margin - size;
  const ops: string[] = ['BT'];
  for (const l of lines) {
    ops.push(`/${l.bold ? 'F2' : 'F1'} ${size} Tf 1 0 0 1 ${margin} ${y.toFixed(2)} Tm ${pdfStr(l.text)} Tj`);
    y -= lead;
  }
  ops.push('ET');
  const content = ops.join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    `<< /Title ${pdfStr(latin(`${doc.store.name} bill ${doc.billNo}`))} /Producer (PosiNext Cloud) >>`,
  ];
  let out = '%PDF-1.4\n%âãÏÓ\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 7 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
