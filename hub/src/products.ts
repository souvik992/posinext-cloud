/**
 * The products PosiNext Cloud serves (ADR-0007; PosiNext Grocery, Apparel and Pharmacy added 2026-11-12): each has its own Windows app, add-ons, licence keys and trial.
 * The code is what keys say (`product`) and what the apps send when they activate.
 */

export type ProductCode = 'fine_dine' | 'tiffin_qsr' | 'grocery' | 'apparel' | 'pharmacy';

export interface ProductInfo {
  code: ProductCode;
  /** The product as customers choose it. */
  name: string;
  /** The Windows app. */
  app: string;
  /** Seats in a trial key. Every key carries all three kinds (the DinePOS app needs them; Tiffin POS reads terminals). */
  trialSeats: { terminals: number; captains: number; kds: number };
}

export const PRODUCTS: Record<ProductCode, ProductInfo> = {
  fine_dine: { code: 'fine_dine', name: 'Fine Dine', app: 'DinePOS', trialSeats: { terminals: 1, captains: 1, kds: 1 } },
  tiffin_qsr: { code: 'tiffin_qsr', name: 'QSR', app: 'Tiffin POS', trialSeats: { terminals: 1, captains: 0, kds: 1 } },
  grocery: { code: 'grocery', name: 'Grocery', app: 'PosiNext Grocery', trialSeats: { terminals: 1, captains: 0, kds: 0 } },
  apparel: { code: 'apparel', name: 'Apparel', app: 'PosiNext Apparel', trialSeats: { terminals: 1, captains: 0, kds: 0 } },
  pharmacy: { code: 'pharmacy', name: 'Pharmacy', app: 'PosiNext Pharmacy', trialSeats: { terminals: 1, captains: 0, kds: 0 } },
};

/** Keys made before products existed, and apps that do not say, are DinePOS (Fine Dine). */
export const DEFAULT_PRODUCT: ProductCode = 'fine_dine';

/** The product code, or null when it is not one of ours. Missing means the default product. */
export function productOf(value: unknown): ProductCode | null {
  if (value === undefined || value === null || value === '') return DEFAULT_PRODUCT;
  return typeof value === 'string' && Object.hasOwn(PRODUCTS, value) ? (value as ProductCode) : null;
}
