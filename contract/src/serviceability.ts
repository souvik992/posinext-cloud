// Online order contract v1: serviceability. Where a store delivers, what it charges, and when it is open.
// Pure (no I/O): the POS add-on checks and stores it, the hub uses it to quote and accept orders, the apps to show it.
// Money is integer paise. Distances are road estimates: straight line x roadFactor (default 1.3), or a measured road distance.

export interface Zone {
  /** This band covers distances above the previous band's upToKm, up to and including this one. */
  upToKm: number;
  deliveryFee: number;
  /** Minimum order value (items total) for delivery in this band. */
  minOrder: number;
  /** Delivery is free when the items total is at least this much (null: never free). */
  freeDeliveryAbove: number | null;
  /** Promised delivery time. */
  etaMinutes: number;
}
export interface Slot { open: string; close: string }
export type Hours = Record<'0' | '1' | '2' | '3' | '4' | '5' | '6', Slot[]>; // 0 = Sunday, IST times "HH:MM"
export interface ServiceabilityConfig {
  location: { lat: number; lng: number; label: string } | null;
  zones: Zone[];
  /** Per-order packaging charge (0 = none). */
  packagingFee: number;
  pickup: { minOrder: number; etaMinutes: number };
  hours: Hours;
  /** Straight-line distance x this = the road distance used for delivery bands (1.0 to 2.0; default 1.3). Ignored when the hub has a road-distance service. */
  roadFactor?: number;
}

export const MAX_KM = 25;
export const MAX_ZONES = 6;
const DAYS = ['0', '1', '2', '3', '4', '5', '6'] as const;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const RUPEES_MAX = 10_000_00; // Rs 10,000

export const DEFAULT_SERVICEABILITY: ServiceabilityConfig = {
  location: null,
  zones: [
    { upToKm: 3, deliveryFee: 2000, minOrder: 10000, freeDeliveryAbove: 50000, etaMinutes: 30 },
    { upToKm: 6, deliveryFee: 4000, minOrder: 20000, freeDeliveryAbove: null, etaMinutes: 45 },
  ],
  packagingFee: 0,
  pickup: { minOrder: 0, etaMinutes: 20 },
  hours: Object.fromEntries(DAYS.map((d) => [d, [{ open: '10:00', close: '22:00' }]])) as Hours,
  roadFactor: 1.3,
};

const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const paise = (v: unknown, max = RUPEES_MAX): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max;

/** Checks a whole configuration; errors are keyed by field ("zones.1.upToKm") in plain words. */
export function checkServiceability(c: unknown): { ok: true; value: ServiceabilityConfig } | { ok: false; errors: Record<string, string> } {
  const e: Record<string, string> = {};
  const x = (c ?? {}) as Partial<ServiceabilityConfig>;
  if (x.location !== null && x.location !== undefined) {
    const l = x.location;
    if (typeof l.lat !== 'number' || l.lat < 6 || l.lat > 38 || typeof l.lng !== 'number' || l.lng < 68 || l.lng > 98) e.location = 'Choose a store location in India on the map.';
    if (typeof l.label !== 'string' || l.label.length > 200) e['location.label'] = 'The address label can be up to 200 characters.';
  }
  const zones = Array.isArray(x.zones) ? x.zones : [];
  if (zones.length > MAX_ZONES) e.zones = `At most ${MAX_ZONES} distance bands.`;
  let prev = 0;
  zones.forEach((z, i) => {
    const k = `zones.${i}`;
    if (typeof z.upToKm !== 'number' || !Number.isFinite(z.upToKm) || Math.round(z.upToKm * 10) !== z.upToKm * 10 || z.upToKm <= prev || z.upToKm > MAX_KM) {
      e[`${k}.upToKm`] = `Distance must be more than ${prev} km and at most ${MAX_KM} km (one decimal).`;
    } else prev = z.upToKm;
    if (!paise(z.deliveryFee)) e[`${k}.deliveryFee`] = 'Enter a delivery fee from Rs 0 to Rs 10,000.';
    if (!paise(z.minOrder)) e[`${k}.minOrder`] = 'Enter a minimum order from Rs 0 to Rs 10,000.';
    if (z.freeDeliveryAbove !== null && !paise(z.freeDeliveryAbove)) e[`${k}.freeDeliveryAbove`] = 'Enter an amount, or leave free delivery empty.';
    if (!Number.isInteger(z.etaMinutes) || z.etaMinutes < 5 || z.etaMinutes > 240) e[`${k}.etaMinutes`] = 'Delivery time must be 5 to 240 minutes.';
  });
  if (x.roadFactor !== undefined && !(typeof x.roadFactor === 'number' && x.roadFactor >= 1 && x.roadFactor <= 2 && Math.round(x.roadFactor * 100) === x.roadFactor * 100)) e.roadFactor = 'Road factor must be 1.00 to 2.00.';
  if (!paise(x.packagingFee, 500_00)) e.packagingFee = 'Packaging fee must be Rs 0 to Rs 500.';
  if (!x.pickup || !paise(x.pickup.minOrder) || !Number.isInteger(x.pickup.etaMinutes) || x.pickup.etaMinutes < 5 || x.pickup.etaMinutes > 240) e.pickup = 'Pickup needs a minimum order (Rs 0 or more) and a ready time of 5 to 240 minutes.';
  const hours = (x.hours ?? {}) as Partial<Hours>;
  for (const d of DAYS) {
    const slots = hours[d];
    if (!Array.isArray(slots) || slots.length > 2) { e[`hours.${d}`] = 'Up to 2 opening times a day.'; continue; }
    slots.forEach((s, i) => {
      if (!s || !TIME.test(s.open) || !TIME.test(s.close) || s.open === s.close) e[`hours.${d}.${i}`] = 'Use times like 10:00 and 22:30 (open and close must differ).';
    });
    if (slots.length === 2 && slots.every((s) => s && TIME.test(s.open) && TIME.test(s.close))) {
      const [a, b] = slots as [Slot, Slot];
      const end = (s: Slot) => minutes(s.close) <= minutes(s.open) ? minutes(s.close) + 1440 : minutes(s.close);
      if (minutes(b.open) < end(a) && minutes(a.open) < end(b)) e[`hours.${d}`] = 'The two opening times overlap.';
    }
  }
  if (Object.keys(e).length) return { ok: false, errors: e };
  return { ok: true, value: { location: x.location ?? null, zones: zones.map((z) => ({ ...z })), packagingFee: x.packagingFee!, pickup: { ...x.pickup! }, hours: Object.fromEntries(DAYS.map((d) => [d, hours[d]!.map((s) => ({ open: s.open, close: s.close }))])) as Hours, roadFactor: x.roadFactor ?? 1.3 } };
}

/** Straight-line distance in km (haversine), rounded to 0.1 km. */
export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371, rad = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)) * 10) / 10;
}

export type Quote =
  | { ok: true; fulfilment: 'DELIVERY' | 'PICKUP'; distanceKm: number | null; zone: number | null; deliveryFee: number; packagingFee: number; minOrder: number; etaMinutes: number }
  | { ok: false; reason: 'NO_LOCATION' | 'OUT_OF_AREA' | 'BELOW_MINIMUM' | 'NO_DELIVERY'; minOrder?: number; shortBy?: number; maxKm?: number };

/** What an order costs to fulfil and whether it can be taken. itemsTotal = what the customer pays for food (paise). */
/** Road distance estimate: a measured road distance when given (km), otherwise straight line x roadFactor. */
export function roadKm(c: ServiceabilityConfig, to: { lat: number; lng: number }, measuredRoadKm?: number | null): number {
  if (typeof measuredRoadKm === 'number' && Number.isFinite(measuredRoadKm) && measuredRoadKm >= 0) return Math.round(measuredRoadKm * 10) / 10;
  return Math.round(distanceKm(c.location!, to) * (c.roadFactor ?? 1.3) * 10) / 10;
}

export function quote(c: ServiceabilityConfig, o: { fulfilment: 'DELIVERY' | 'PICKUP'; to?: { lat: number; lng: number }; itemsTotal: number; measuredRoadKm?: number | null }): Quote {
  if (o.fulfilment === 'PICKUP') {
    if (o.itemsTotal < c.pickup.minOrder) return { ok: false, reason: 'BELOW_MINIMUM', minOrder: c.pickup.minOrder, shortBy: c.pickup.minOrder - o.itemsTotal };
    return { ok: true, fulfilment: 'PICKUP', distanceKm: null, zone: null, deliveryFee: 0, packagingFee: c.packagingFee, minOrder: c.pickup.minOrder, etaMinutes: c.pickup.etaMinutes };
  }
  if (!c.location) return { ok: false, reason: 'NO_LOCATION' };
  if (c.zones.length === 0) return { ok: false, reason: 'NO_DELIVERY' };
  if (!o.to) return { ok: false, reason: 'OUT_OF_AREA', maxKm: c.zones.at(-1)!.upToKm };
  const km = roadKm(c, o.to, o.measuredRoadKm);
  const zone = c.zones.findIndex((z) => km <= z.upToKm);
  if (zone < 0) return { ok: false, reason: 'OUT_OF_AREA', maxKm: c.zones.at(-1)!.upToKm };
  const z = c.zones[zone]!;
  if (o.itemsTotal < z.minOrder) return { ok: false, reason: 'BELOW_MINIMUM', minOrder: z.minOrder, shortBy: z.minOrder - o.itemsTotal };
  const free = z.freeDeliveryAbove !== null && o.itemsTotal >= z.freeDeliveryAbove;
  return { ok: true, fulfilment: 'DELIVERY', distanceKm: km, zone, deliveryFee: free ? 0 : z.deliveryFee, packagingFee: c.packagingFee, minOrder: z.minOrder, etaMinutes: z.etaMinutes };
}

const IST = 330 * 60_000;
/** Is the store open at this moment (IST)? A slot that closes at or before it opens runs past midnight. */
export function isOpen(hours: Hours, at: number): boolean {
  const d = new Date(at + IST);
  const day = d.getUTCDay(), now = d.getUTCHours() * 60 + d.getUTCMinutes();
  const today = hours[String(day) as keyof Hours] ?? [], yesterday = hours[String((day + 6) % 7) as keyof Hours] ?? [];
  for (const s of today) {
    const o = minutes(s.open), c = minutes(s.close);
    if (c > o ? now >= o && now < c : now >= o) return true;
  }
  for (const s of yesterday) { const o = minutes(s.open), c = minutes(s.close); if (c <= o && now < c) return true; } // tail of last night's slot
  return false;
}
