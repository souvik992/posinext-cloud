// Online order contract v1: the menu a POS publishes to the hub, and pricing an order from it.
// Pricing uses the POS's own tax calculation (src/core/tax.ts, pure) on the same lines the POS will bill (items merged the
// way the POS merges them, then the delivery and packaging fee lines), so the customer's total equals the POS bill.
import { computeInvoice } from '../../core/tax.ts';
import { mulDivRound } from '../../core/money.ts';
import type { TaxableLineInput } from '../../core/tax.ts';
import type { OrderLine } from './types.ts';
import type { ServiceabilityConfig } from './serviceability.ts';

export interface MenuItem {
  id: string; categoryId: string | null; name: string; price: number; unit: string; isVeg: boolean | null;
  rateBp: number; cessBp: number; priceIncludesTax: boolean; modifierGroupIds: string[]; available: boolean;
  /** The item's photo: "<sha256 of the bytes>.<jpg|png|webp>"; the hub serves it at /v1/stores/<slug>/images/<image>. */
  image?: string | null;
  /** A short description for the online menu. */
  description?: string | null;
  /** The sales channels that list this item (menu sync per channel). Missing: every channel. */
  channels?: Array<'app' | 'website' | 'swiggy' | 'zomato'>;
  /** A channel's own price for this item (paise) when the channel does not use the POS price. */
  prices?: Partial<Record<'app' | 'website' | 'swiggy' | 'zomato', number>>;
}

/** How a channel prices the menu: the POS price, or the POS price plus a percentage (to whole rupees) with per-item prices. */
export interface ChannelPricing { pricing: 'same' | 'custom'; markupBp: number; prices: Record<string, number> }

/** An item's price on a channel (paise). One rule for the POS (its bill) and the hub (the customer's total). */
export function channelPrice(itemId: string, posPrice: number, p: ChannelPricing): number {
  if (p.pricing !== 'custom') return posPrice;
  const own = p.prices[itemId];
  if (Number.isSafeInteger(own) && own! >= 0) return own!;
  if (!p.markupBp) return posPrice;
  const raised = mulDivRound(posPrice, 10000 + p.markupBp, 10000);
  return Math.max(0, raised + 50 - ((raised + 50) % 100)); // to the nearest rupee
}
export interface MenuModifierGroup { id: string; name: string; minSelect: number; maxSelect: number; modifiers: Array<{ id: string; name: string; price: number }> }
export interface StoreOptions {
  acceptMode: 'manual' | 'auto'; acceptTimeoutMin: number;
  channels: { app: boolean; website: boolean; swiggy: boolean; zomato: boolean };
  fulfilment: { pickup: boolean; delivery: boolean }; payments: { online: boolean; cod: boolean };
}
/** Everything a POS publishes (PUT /v1/pos/menu). `version` increases with every change. */
export interface PublishedMenu {
  version: number;
  storeName: string;
  categories: Array<{ id: string; name: string; sort: number }>;
  items: MenuItem[];
  modifierGroups: MenuModifierGroup[];
  roundToRupee: boolean;
  /** GST on delivery and packaging charges (null: no fees can be charged). */
  feeTax: { rateBp: number; cessBp: number; priceIncludesTax: boolean } | null;
  options: StoreOptions;
  serviceability: ServiceabilityConfig;
}

export type Priced =
  | { ok: true; lines: OrderLine[]; itemsTotal: number; deliveryFee: number; packagingFee: number; total: number }
  | { ok: false; reason: 'ITEM_UNAVAILABLE' | 'OPTION_INVALID'; itemId: string; message: string };

/** Prices cart lines (and optional fees) from a published menu. Never trusts prices from the app. */
export function priceOrder(menu: Pick<PublishedMenu, 'items' | 'modifierGroups' | 'roundToRupee' | 'feeTax'>, cart: Array<{ itemId: string; qtyMilli: number; modifierIds?: string[]; note?: string | null }>, fees: { delivery: number; packaging: number } = { delivery: 0, packaging: 0 }): Priced {
  const items = new Map(menu.items.map((i) => [i.id, i]));
  const groups = new Map(menu.modifierGroups.map((g) => [g.id, g]));
  // merge identical lines exactly like the POS does (same item, same options, same note)
  const merged: Array<{ item: MenuItem; qtyMilli: number; mods: Array<{ id: string; name: string; price: number }>; note: string | null; key: string }> = [];
  for (const l of cart) {
    const item = items.get(l.itemId);
    if (!item || !item.available) return { ok: false, reason: 'ITEM_UNAVAILABLE', itemId: l.itemId, message: `${item?.name ?? 'An item'} is not available right now.` };
    const ids = [...new Set(l.modifierIds ?? [])];
    const mods: Array<{ id: string; name: string; price: number; groupId: string }> = [];
    for (const id of ids) {
      const g = item.modifierGroupIds.map((gid) => groups.get(gid)).find((x) => x?.modifiers.some((m) => m.id === id));
      const m = g?.modifiers.find((x) => x.id === id);
      if (!g || !m) return { ok: false, reason: 'OPTION_INVALID', itemId: item.id, message: `An option for ${item.name} is not available.` };
      mods.push({ ...m, groupId: g.id });
    }
    for (const gid of item.modifierGroupIds) {
      const g = groups.get(gid);
      if (!g) continue;
      const n = mods.filter((m) => m.groupId === gid).length;
      if (n < g.minSelect || n > g.maxSelect) return { ok: false, reason: 'OPTION_INVALID', itemId: item.id, message: `Choose ${g.minSelect === g.maxSelect ? g.minSelect : `${g.minSelect} to ${g.maxSelect}`} option(s) for ${g.name} (${item.name}).` };
    }
    mods.sort((a, b) => (a.id < b.id ? -1 : 1));
    const note = l.note?.trim() ? l.note.trim().slice(0, 120) : null;
    const key = `${item.id}|${mods.map((m) => m.id).join(',')}|${note ?? ''}`;
    const same = merged.find((x) => x.key === key);
    if (same) same.qtyMilli += l.qtyMilli;
    else merged.push({ item, qtyMilli: l.qtyMilli, mods: mods.map(({ id, name, price }) => ({ id, name, price })), note, key });
  }
  const tax = menu.feeTax;
  if ((fees.delivery > 0 || fees.packaging > 0) && !tax) return { ok: false, reason: 'ITEM_UNAVAILABLE', itemId: 'fees', message: 'Delivery is not set up for this store yet.' };
  const inputs: TaxableLineInput[] = merged.map((m, i) => ({ id: String(i), qtyMilli: m.qtyMilli, unitPrice: m.item.price + m.mods.reduce((s, x) => s + x.price, 0), rateBp: m.item.rateBp, cessBp: m.item.cessBp, priceIncludesTax: m.item.priceIncludesTax }));
  const itemCalc = computeInvoice(inputs, { intraState: true, roundToRupee: false });
  const feeInputs: TaxableLineInput[] = [];
  if (fees.delivery > 0) feeInputs.push({ id: 'delivery', qtyMilli: 1000, unitPrice: fees.delivery, rateBp: tax!.rateBp, cessBp: tax!.cessBp, priceIncludesTax: tax!.priceIncludesTax });
  if (fees.packaging > 0) feeInputs.push({ id: 'packaging', qtyMilli: 1000, unitPrice: fees.packaging, rateBp: tax!.rateBp, cessBp: tax!.cessBp, priceIncludesTax: tax!.priceIncludesTax });
  const all = computeInvoice([...inputs, ...feeInputs], { intraState: true, roundToRupee: menu.roundToRupee });
  const feeLine = (id: string) => all.lines.find((l) => l.id === id)?.lineTotal ?? 0;
  return {
    ok: true,
    lines: merged.map((m, i) => ({ itemId: m.item.id, name: m.item.name, qtyMilli: m.qtyMilli, unitPrice: inputs[i]!.unitPrice, modifiers: m.mods, note: m.note, lineTotal: all.lines[i]!.lineTotal })),
    itemsTotal: itemCalc.lines.reduce((s, l) => s + l.lineTotal, 0),
    deliveryFee: feeLine('delivery'), packagingFee: feeLine('packaging'),
    total: all.grandTotal,
  };
}
