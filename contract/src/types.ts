// Online order contract v1: data shapes. Money is integer paise, quantities integer thousandths, times ms since epoch (UTC).
import type { Fulfilment, OrderState, PaymentMethod } from './order.ts';

export interface Customer { name: string | null; mobile: string; /** true when the mobile was confirmed by OTP */ verified: boolean }
export interface Address { line1: string; line2: string | null; landmark: string | null; city: string; pincode: string }
export interface Rider { name: string; phone: string | null }

export const REJECT_REASONS = ['ITEM_UNAVAILABLE', 'TOO_BUSY', 'CLOSING', 'OUT_OF_DELIVERY_AREA', 'OTHER'] as const;
export type RejectReason = typeof REJECT_REASONS[number];

/** What a customer app sends to place an order. The hub re-prices it from the published menu; the totals here are what the customer saw. */
export interface PlaceOrderRequest {
  fulfilment: Fulfilment;
  payment: PaymentMethod;
  customer: { name?: string | null; mobile: string };
  /** Proof that the mobile was verified by OTP (from POST /v1/otp/verify). Required for COD. */
  otpToken?: string | null;
  address?: Address | null;
  /** Delivery: the customer's map point (from the app's map or the phone's location). Distance and fees are measured to it. */
  location?: { lat: number; lng: number } | null;
  /** Which sales channel the order comes from (default website). */
  channel?: 'app' | 'website';
  lines: Array<{ itemId: string; qtyMilli: number; modifierIds?: string[]; note?: string | null }>;
  note?: string | null;
  /** The menu version the customer ordered from (see F5: price changes). */
  menuVersion: number;
  /** The total the customer was shown, in paise. */
  expectedTotal: number;
}

/** A Swiggy or Zomato order (through UrbanPiper): what the platform says about it. Missing on the store's own app and website orders. */
export interface ExternalOrder {
  platform: 'swiggy' | 'zomato';
  /** The platform's own order number (what its rider and the customer quote). */
  orderId: string;
  /** Who delivers: the platform's riders, or the store's own (self-delivery). */
  deliveredBy: 'platform' | 'store';
  /** The OTP the platform's rider gives at pickup, when the platform sends one. */
  otp: string | null;
  /** What the platform charged the customer (paise), with its own discounts and charges. */
  platformTotal: number;
  charges: Array<{ title: string; amount: number }>;
  discounts: Array<{ title: string; amount: number; byStore: boolean }>;
  /** Things the store should know before accepting (an item not on the POS menu, cash the rider collects, ...). */
  notes: string[];
  /** The platform rider's progress as the platform words it ("Assigned", "At store", ...); set by the POS from order.rider events. */
  riderStatus?: string | null;
  /** Zomato bulk order: the store may ask for an extra rider. */
  bulk?: boolean;
}

/** What the store can ask the platform about one of its orders (POST /v1/pos/orders/{id}/platform-action). */
export type PlatformAction =
  /** Swiggy, before the food is ready: these items ran out. allowEdit: Swiggy asks the customer to change the order (the
   * store gets the customer's masked number and a PIN to call); false: the order is cancelled. */
  | { action: 'items_out_of_stock'; itemIds: string[]; allowEdit: boolean }
  /** Zomato bulk orders: one more rider. */
  | { action: 'extra_rider' }
  /** Zomato: the customer's (masked) phone number. */
  | { action: 'customer_phone' }
  /** Zomato rider safety check: body temperature (Fahrenheit) and mask. riderPhone: the store's own rider only. */
  | { action: 'rider_check'; temperatureF: number; wearingMask: boolean; riderPhone?: string | null };

export interface OrderLine { itemId: string; name: string; qtyMilli: number; unitPrice: number; modifiers: Array<{ id: string; name: string; price: number }>; note: string | null; lineTotal: number }

/** An order as the hub stores it and sends it to the POS. */
export interface Order {
  id: string;
  /** Short number for people, e.g. "W-1042" (website), "A-77" (app). */
  number: string;
  storeId: string;
  channel: 'app' | 'website' | 'swiggy' | 'zomato';
  state: OrderState;
  fulfilment: Fulfilment;
  payment: PaymentMethod;
  paid: boolean;
  customer: Customer;
  address: Address | null;
  lines: OrderLine[];
  note: string | null;
  itemsTotal: number;
  deliveryFee: number;
  packagingFee: number;
  total: number;
  /** Delivery: distance used for the fee (km, road estimate), and the customer's map point. */
  distanceKm: number | null;
  location: { lat: number; lng: number } | null;
  /** Set when the store accepts: preparation minutes and the promised time. */
  prepMinutes: number | null;
  etaAt: number | null;
  menuVersion: number;
  placedAt: number;
  /** Manual mode: the hub auto-rejects at this time unless the store answers. Null in auto-accept mode. */
  acceptBy: number | null;
  rider: Rider | null;
  posBillNo: string | null;
  rejectReason: RejectReason | null;
  reasonText: string | null;
  /** Swiggy / Zomato orders only. */
  external?: ExternalOrder | null;
}

/** Events the hub pushes down the POS's SSE stream (GET /v1/pos/events). `seq` is the SSE event id; the POS resumes with Last-Event-ID. */
export type PosEvent =
  | { seq: number; type: 'order.created'; at: number; order: Order }
  | { seq: number; type: 'order.cancelled'; at: number; orderId: string; by: 'customer' | 'aggregator'; reasonText: string | null }
  | { seq: number; type: 'order.auto_rejected'; at: number; orderId: string }
  | { seq: number; type: 'order.updated'; at: number; orderId: string; state: OrderState; by: 'pos' | 'aggregator' }
  /** Swiggy / Zomato: their rider's details and progress (assigned, at the store, out for delivery, ...). */
  | { seq: number; type: 'order.rider'; at: number; orderId: string; rider: Rider | null; riderStatus: string | null }
  /** Swiggy / Zomato: something the store should read on the order (the customer's number, a refused request, ...). */
  | { seq: number; type: 'order.notice'; at: number; orderId: string; text: string };

/** Events the hub pushes to the customer app (GET /v1/orders/{id}/events). */
export type CustomerEvent = { seq: number; type: 'order.state'; at: number; orderId: string; state: OrderState; label: string; etaMinutes: number | null; rider: Rider | null };

/** Store settings the POS publishes with its menu (PUT /v1/pos/menu). */
export interface StoreOnlineSettings {
  acceptMode: 'manual' | 'auto';
  /** Manual mode: minutes before an unanswered order is auto-rejected (2-15, default 5). */
  acceptTimeoutMin: number;
  channels: { app: boolean; website: boolean; swiggy: boolean; zomato: boolean };
  fulfilment: { pickup: boolean; delivery: boolean };
  payments: { online: boolean; cod: boolean };
}
