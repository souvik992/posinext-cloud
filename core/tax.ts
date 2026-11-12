import { assertSafeInt, mulDivRound, sum } from './money.ts';
import { apportion, resolveDiscount } from './discount.ts';
import type { DiscountSpec } from './discount.ts';

export interface TaxableLineInput {
  id: string;
  qtyMilli: number;
  unitPrice: number; // paise per unit (includes modifier prices)
  discount?: DiscountSpec | null;
  rateBp: number; // GST rate, basis points (500 = 5%)
  cessBp: number;
  priceIncludesTax: boolean;
}

export interface ComputedLine {
  id: string;
  qtyMilli: number;
  unitPrice: number;
  gross: number;
  discount: number; // line discount + apportioned bill discount
  taxable: number;
  rateBp: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
  lineTotal: number;
}

export interface InvoiceComputation {
  lines: ComputedLine[];
  grossTotal: number;
  discountTotal: number;
  taxableTotal: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
  roundOff: number;
  grandTotal: number;
}

export interface ComputeOptions {
  billDiscount?: DiscountSpec | null;
  intraState: boolean;
  roundToRupee: boolean;
}

export const MAX_QTY_MILLI = 10_000_000; // 10,000 units per line

export function lineGross(qtyMilli: number, unitPrice: number): number {
  if (qtyMilli <= 0) throw new RangeError('quantity must be positive');
  if (qtyMilli > MAX_QTY_MILLI) throw new RangeError('quantity too large');
  return mulDivRound(qtyMilli, unitPrice, 1000);
}

interface TaxParts {
  taxable: number;
  gst: number;
  cess: number;
  lineTotal: number;
}

function taxParts(net: number, rateBp: number, cessBp: number, inclusive: boolean): TaxParts {
  if (rateBp < 0 || cessBp < 0) throw new RangeError('tax rates must be non-negative');
  if (inclusive) {
    const taxable = mulDivRound(net, 10000, 10000 + rateBp + cessBp);
    const totalTax = net - taxable;
    const combined = rateBp + cessBp;
    const gst = combined === 0 ? 0 : mulDivRound(totalTax, rateBp, combined);
    return { taxable, gst, cess: totalTax - gst, lineTotal: net };
  }
  const gst = mulDivRound(net, rateBp, 10000);
  const cess = mulDivRound(net, cessBp, 10000);
  return { taxable: net, gst, cess, lineTotal: net + gst + cess };
}

export function computeInvoice(inputs: readonly TaxableLineInput[], opts: ComputeOptions): InvoiceComputation {
  const pre = inputs.map((l) => {
    const gross = lineGross(l.qtyMilli, l.unitPrice);
    const lineDisc = l.discount ? resolveDiscount(l.discount, gross) : 0;
    return { l, gross, lineDisc, remaining: gross - lineDisc };
  });
  const remainingTotal = sum(pre.map((p) => p.remaining));
  const billDisc = opts.billDiscount ? resolveDiscount(opts.billDiscount, remainingTotal) : 0;
  const shares = apportion(billDisc, pre.map((p) => p.remaining));

  const lines: ComputedLine[] = pre.map((p, i) => {
    const discount = p.lineDisc + shares[i]!;
    const net = p.gross - discount;
    const t = taxParts(net, p.l.rateBp, p.l.cessBp, p.l.priceIncludesTax);
    // Intra-state: the odd paisa always goes to CGST (one fixed rule).
    const sgst = opts.intraState ? Math.floor(t.gst / 2) : 0;
    const cgst = opts.intraState ? t.gst - sgst : 0;
    const igst = opts.intraState ? 0 : t.gst;
    return {
      id: p.l.id,
      qtyMilli: p.l.qtyMilli,
      unitPrice: p.l.unitPrice,
      gross: p.gross,
      discount,
      taxable: t.taxable,
      rateBp: p.l.rateBp,
      cgst,
      sgst,
      igst,
      cess: t.cess,
      lineTotal: t.lineTotal,
    };
  });

  const preRound = sum(lines.map((l) => l.lineTotal));
  const grandTotal = opts.roundToRupee ? Math.floor((preRound + 50) / 100) * 100 : preRound;
  return {
    lines,
    grossTotal: sum(lines.map((l) => l.gross)),
    discountTotal: sum(lines.map((l) => l.discount)),
    taxableTotal: sum(lines.map((l) => l.taxable)),
    cgst: sum(lines.map((l) => l.cgst)),
    sgst: sum(lines.map((l) => l.sgst)),
    igst: sum(lines.map((l) => l.igst)),
    cess: sum(lines.map((l) => l.cess)),
    roundOff: grandTotal - preRound,
    grandTotal,
  };
}

/** Returns a list of violated invariants (empty means the computation is internally consistent). */
export function checkInvariants(c: InvoiceComputation): string[] {
  const errs: string[] = [];
  for (const l of c.lines) {
    for (const [k, v] of Object.entries(l)) {
      if (typeof v === 'number') {
        try { assertSafeInt(v, k); } catch { errs.push(`line ${l.id}: ${k} not a safe integer`); }
        if (v < 0) errs.push(`line ${l.id}: ${k} negative`);
      }
    }
    if (l.taxable + l.cgst + l.sgst + l.igst + l.cess !== l.lineTotal) errs.push(`line ${l.id}: parts do not add to total`);
  }
  if (sum(c.lines.map((l) => l.lineTotal)) + c.roundOff !== c.grandTotal) errs.push('lines + roundOff != grandTotal');
  if (sum(c.lines.map((l) => l.gross)) !== c.grossTotal) errs.push('gross mismatch');
  if (sum(c.lines.map((l) => l.discount)) !== c.discountTotal) errs.push('discount mismatch');
  if (sum(c.lines.map((l) => l.taxable)) !== c.taxableTotal) errs.push('taxable mismatch');
  if (Math.abs(c.roundOff) > 50) errs.push('roundOff exceeds 50 paise');
  return errs;
}
