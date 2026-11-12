// Money is INTEGER PAISE everywhere. Quantity is INTEGER THOUSANDTHS (1.5 kg = 1500).
// No floating point arithmetic is ever used for amounts.

export function assertSafeInt(n: number, label = 'value'): void {
  if (!Number.isSafeInteger(n)) throw new RangeError(`${label} must be a safe integer, got ${n}`);
}

/** round-half-up of (a*b)/c for non-negative integers. BigInt intermediate, so it cannot overflow. */
export function mulDivRound(a: number, b: number, c: number): number {
  assertSafeInt(a, 'a');
  assertSafeInt(b, 'b');
  assertSafeInt(c, 'c');
  if (a < 0 || b < 0) throw new RangeError('mulDivRound expects non-negative operands');
  if (c <= 0) throw new RangeError('mulDivRound divisor must be positive');
  const den = BigInt(c);
  const q = (BigInt(a) * BigInt(b) * 2n + den) / (den * 2n);
  const out = Number(q);
  assertSafeInt(out, 'result');
  return out;
}

export function sum(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  assertSafeInt(s, 'sum');
  return s;
}

/** Format paise with Indian digit grouping: 12345678 -> 1,23,456.78. Symbol defaults to the rupee sign. */
export function formatINR(paise: number, symbol = '\u20b9'): string {
  assertSafeInt(paise, 'paise');
  const neg = paise < 0;
  const abs = Math.abs(paise);
  const ps = abs % 100;
  let r = String(Math.floor(abs / 100));
  if (r.length > 3) {
    const last3 = r.slice(-3);
    const rest = r.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
    r = `${rest},${last3}`;
  }
  return `${neg ? '-' : ''}${symbol}${r}.${String(ps).padStart(2, '0')}`;
}

/** Parse a rupee string such as "120", "120.5", "1,20,000.75" into paise without floats. */
export function parsePaise(input: string): number {
  const s = input.trim().replace(/,/g, '');
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new RangeError(`invalid rupee amount: "${input}"`);
  const rupees = Number(m[1]);
  const ps = m[2] ? Number(m[2].padEnd(2, '0')) : 0;
  return rupees * 100 + ps;
}

/** Quantity (thousandths) to display text: 1000 -> "1", 1500 -> "1.5", 250 -> "0.25". */
export function formatQty(qtyMilli: number): string {
  assertSafeInt(qtyMilli, 'qty');
  const whole = Math.floor(qtyMilli / 1000);
  const frac = String(qtyMilli % 1000).padStart(3, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}
