// Online order contract v1: checks on what a customer app sends. Used by the hub (authoritative) and the apps (instant feedback).
import type { Address, PlaceOrderRequest } from './types.ts';

export type Checked<T> = { ok: true; value: T } | { ok: false; errors: Record<string, string> };

export const MOBILE_RE = /^[6-9]\d{9}$/; // Indian mobile numbers
export const PINCODE_RE = /^[1-9]\d{5}$/;
export const MAX_LINES = 50;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const optText = (v: unknown, max: number) => v === undefined || v === null || (typeof v === 'string' && v.length <= max);
const int = (v: unknown, min: number, max: number): v is number => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;

/** "+91 98765 43210", "098765 43210" -> "9876543210"; anything else stays as typed (and fails MOBILE_RE). */
export function normaliseMobile(s: string): string {
  const d = s.replace(/[\s-]/g, '').replace(/^\+91/, '').replace(/^0(?=\d{10}$)/, '');
  return d;
}

export function checkPlaceOrder(input: unknown): Checked<PlaceOrderRequest> {
  const e: Record<string, string> = {};
  if (!isObj(input)) return { ok: false, errors: { order: 'The order is missing.' } };
  const fulfilment = input.fulfilment, payment = input.payment;
  if (fulfilment !== 'PICKUP' && fulfilment !== 'DELIVERY') e.fulfilment = 'Choose pickup or delivery.';
  if (payment !== 'ONLINE' && payment !== 'COD') e.payment = 'Choose online payment or cash on delivery.';

  const c = isObj(input.customer) ? input.customer : {};
  const mobile = typeof c.mobile === 'string' ? normaliseMobile(c.mobile) : '';
  if (!MOBILE_RE.test(mobile)) e.mobile = 'Enter a 10-digit mobile number.';
  if (!optText(c.name, 60)) e.name = 'Name can be up to 60 characters.';
  // Cash on delivery only for a verified mobile: stops fake COD orders. Guest checkout (no OTP) pays online.
  if (payment === 'COD' && !text(input.otpToken, 200)) e.otp = 'Verify your mobile number with the OTP to pay cash on delivery.';

  let address: Address | null = null;
  if (fulfilment === 'DELIVERY') {
    const a = isObj(input.address) ? input.address : null;
    if (!a) e.address = 'Enter the delivery address.';
    else {
      if (!text(a.line1, 120)) e['address.line1'] = 'Enter the house / flat and street.';
      if (!optText(a.line2, 120) || !optText(a.landmark, 80)) e['address.line2'] = 'Address lines can be up to 120 characters.';
      if (!text(a.city, 60)) e['address.city'] = 'Enter the city.';
      if (typeof a.pincode !== 'string' || !PINCODE_RE.test(a.pincode)) e['address.pincode'] = 'Enter a 6-digit PIN code.';
      address = { line1: String(a.line1 ?? '').trim(), line2: (a.line2 as string | null | undefined)?.trim() || null, landmark: (a.landmark as string | null | undefined)?.trim() || null, city: String(a.city ?? '').trim(), pincode: String(a.pincode ?? '') };
    }
  }

  let location: { lat: number; lng: number } | null = null;
  if (fulfilment === 'DELIVERY') {
    const l = input.location as { lat?: unknown; lng?: unknown } | null | undefined;
    if (!l || typeof l.lat !== 'number' || typeof l.lng !== 'number' || l.lat < 6 || l.lat > 38 || l.lng < 68 || l.lng > 98) e.location = 'Mark the delivery location on the map.';
    else location = { lat: l.lat, lng: l.lng };
  }
  if (input.channel !== undefined && input.channel !== 'app' && input.channel !== 'website') e.channel = 'Unknown sales channel.';

  const lines = Array.isArray(input.lines) ? input.lines : [];
  if (lines.length === 0) e.lines = 'The cart is empty.';
  else if (lines.length > MAX_LINES) e.lines = `At most ${MAX_LINES} different items per order.`;
  lines.forEach((l: unknown, i: number) => {
    if (!isObj(l) || !text(l.itemId, 64) || !int(l.qtyMilli, 1, 100_000) || (l.modifierIds !== undefined && !(Array.isArray(l.modifierIds) && l.modifierIds.length <= 20 && l.modifierIds.every((m) => text(m, 64)))) || !optText(l.note, 200)) {
      e[`lines.${i}`] = 'This cart item is not valid. Remove it and add it again.';
    }
  });
  if (!optText(input.note, 300)) e.note = 'The note can be up to 300 characters.';
  if (!int(input.menuVersion, 1, Number.MAX_SAFE_INTEGER)) e.menuVersion = 'The menu is out of date. Reload it.';
  if (!int(input.expectedTotal, 0, 10_000_000_00)) e.expectedTotal = 'The total is not valid.';

  if (Object.keys(e).length) return { ok: false, errors: e };
  const name = typeof c.name === 'string' && c.name.trim() ? c.name.trim() : null;
  return {
    ok: true,
    value: {
      fulfilment: fulfilment as PlaceOrderRequest['fulfilment'], payment: payment as PlaceOrderRequest['payment'],
      customer: { name, mobile }, otpToken: typeof input.otpToken === 'string' ? input.otpToken : null, address, location, channel: (input.channel as 'app' | 'website' | undefined) ?? 'website',
      lines: lines.map((l) => { const x = l as Record<string, unknown>; return { itemId: x.itemId as string, qtyMilli: x.qtyMilli as number, modifierIds: (x.modifierIds as string[] | undefined) ?? [], note: (x.note as string | null | undefined) ?? null }; }),
      note: (input.note as string | null | undefined) ?? null, menuVersion: input.menuVersion as number, expectedTotal: input.expectedTotal as number,
    },
  };
}
