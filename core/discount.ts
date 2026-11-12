import { assertSafeInt, mulDivRound } from './money.ts';

/** amount: paise. percent: basis points (1000 = 10%). */
export type DiscountSpec = { type: 'amount'; value: number } | { type: 'percent'; value: number };

export function resolveDiscount(spec: DiscountSpec, base: number): number {
  assertSafeInt(spec.value, 'discount value');
  if (spec.value < 0) throw new RangeError('discount cannot be negative');
  if (spec.type === 'percent') {
    if (spec.value > 10000) throw new RangeError('percent discount cannot exceed 100%');
    return mulDivRound(base, spec.value, 10000);
  }
  if (spec.value > base) throw new RangeError('discount exceeds amount');
  return spec.value;
}

/**
 * Largest-remainder apportionment: splits `total` across `weights` so the parts sum EXACTLY to total.
 * Ties go to the lowest index. Each share never exceeds its weight.
 */
export function apportion(total: number, weights: readonly number[]): number[] {
  assertSafeInt(total, 'total');
  const n = weights.length;
  const out: number[] = new Array(n).fill(0);
  if (total === 0 || n === 0) return out;
  let W = 0n;
  for (const w of weights) {
    assertSafeInt(w, 'weight');
    if (w < 0) throw new RangeError('weights must be non-negative');
    W += BigInt(w);
  }
  if (W === 0n) throw new RangeError('cannot apportion over zero total weight');
  if (BigInt(total) > W) throw new RangeError('total exceeds sum of weights');
  const rem: bigint[] = new Array(n);
  let allocated = 0;
  for (let i = 0; i < n; i++) {
    const num = BigInt(total) * BigInt(weights[i]!);
    out[i] = Number(num / W);
    rem[i] = num % W;
    allocated += out[i]!;
  }
  const left = total - allocated;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) =>
    rem[b]! > rem[a]! ? 1 : rem[b]! < rem[a]! ? -1 : a - b,
  );
  for (let k = 0; k < left; k++) out[order[k]!]!++;
  return out;
}
