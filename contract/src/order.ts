// Online order contract v1: the order life cycle shared by the hub, the POS connector and the customer apps.
// Zero dependencies, no I/O. Changing a transition here is an API change: keep v1 backward compatible.

export const ORDER_STATES = [
  'PLACED', 'PAYMENT_PENDING', 'PAYMENT_FAILED', 'SENT_TO_STORE', 'RECEIVED',
  'ACCEPTED', 'REJECTED', 'AUTO_REJECTED', 'PREPARING', 'READY',
  'OUT_FOR_DELIVERY', 'DELIVERED', 'PICKED_UP', 'CANCELLED',
] as const;
export type OrderState = typeof ORDER_STATES[number];

export type Fulfilment = 'PICKUP' | 'DELIVERY';
export type PaymentMethod = 'ONLINE' | 'COD';
/** Who may cause a transition. 'gateway' = payment gateway webhook; 'hub' = hub timers and rules;
 * 'aggregator' = Swiggy or Zomato (through UrbanPiper) for the orders they take: they cancel, and their riders deliver. */
export type Actor = 'customer' | 'pos' | 'hub' | 'gateway' | 'aggregator';

export const TERMINAL: readonly OrderState[] = ['REJECTED', 'AUTO_REJECTED', 'CANCELLED', 'DELIVERED', 'PICKED_UP'];

interface Rule { from: readonly OrderState[]; to: OrderState; by: readonly Actor[]; when?: (o: OrderFacts) => boolean; note: string }
/** deliveredBy 'platform': a Swiggy or Zomato rider delivers (only the platform marks it picked up and delivered). Missing: the store. */
export interface OrderFacts { fulfilment: Fulfilment; payment: PaymentMethod; deliveredBy?: 'store' | 'platform' }
const ownRider = (o: OrderFacts) => o.fulfilment === 'DELIVERY' && o.deliveredBy !== 'platform';

/** Every allowed change of state. Anything not listed is refused. */
export const TRANSITIONS: readonly Rule[] = [
  { from: ['PLACED'], to: 'PAYMENT_PENDING', by: ['customer'], when: (o) => o.payment === 'ONLINE', note: 'customer starts online payment' },
  { from: ['PLACED'], to: 'SENT_TO_STORE', by: ['hub'], when: (o) => o.payment === 'COD', note: 'COD order goes straight to the store' },
  { from: ['PAYMENT_PENDING'], to: 'SENT_TO_STORE', by: ['gateway'], note: 'payment captured (webhook)' },
  { from: ['PAYMENT_PENDING'], to: 'PAYMENT_FAILED', by: ['gateway', 'hub'], note: 'payment failed, or not finished in 15 minutes' },
  { from: ['PAYMENT_FAILED'], to: 'PAYMENT_PENDING', by: ['customer'], note: 'customer tries to pay again' },
  { from: ['SENT_TO_STORE'], to: 'RECEIVED', by: ['pos'], note: 'the POS has stored the order' },
  { from: ['SENT_TO_STORE', 'RECEIVED'], to: 'ACCEPTED', by: ['pos'], note: 'store accepts (or the POS in auto-accept mode); the POS makes the GST bill' },
  { from: ['SENT_TO_STORE', 'RECEIVED'], to: 'REJECTED', by: ['pos'], note: 'store rejects with a reason; refund if paid' },
  { from: ['SENT_TO_STORE', 'RECEIVED'], to: 'AUTO_REJECTED', by: ['hub'], note: 'no answer within the store\'s accept time; refund if paid' },
  { from: ['PLACED', 'PAYMENT_PENDING', 'PAYMENT_FAILED', 'SENT_TO_STORE', 'RECEIVED'], to: 'CANCELLED', by: ['customer'], note: 'customer cancels before the store accepts; refund if paid' },
  { from: ['ACCEPTED'], to: 'PREPARING', by: ['pos'], note: 'kitchen starts' },
  { from: ['ACCEPTED', 'PREPARING'], to: 'READY', by: ['pos'], note: 'food is ready' },
  { from: ['READY'], to: 'OUT_FOR_DELIVERY', by: ['pos'], when: ownRider, note: 'handed to an in-house rider' },
  { from: ['OUT_FOR_DELIVERY'], to: 'DELIVERED', by: ['pos'], when: ownRider, note: 'rider delivered (COD: cash collected)' },
  { from: ['READY'], to: 'PICKED_UP', by: ['pos'], when: (o) => o.fulfilment === 'PICKUP', note: 'customer collected' },
  { from: ['ACCEPTED', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY'], to: 'CANCELLED', by: ['pos'], note: 'store cancels after accepting (credit note in the POS; refund if paid)' },
  // Swiggy / Zomato orders (through UrbanPiper)
  { from: ['SENT_TO_STORE', 'RECEIVED', 'ACCEPTED', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY'], to: 'CANCELLED', by: ['aggregator'], note: 'the platform cancelled (customer, rider or platform); credit note in the POS if billed' },
  { from: ['ACCEPTED', 'PREPARING', 'READY'], to: 'OUT_FOR_DELIVERY', by: ['aggregator'], when: (o) => o.fulfilment === 'DELIVERY', note: "the platform's rider picked the food up" },
  { from: ['ACCEPTED', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY'], to: 'DELIVERED', by: ['aggregator'], when: (o) => o.fulfilment === 'DELIVERY', note: 'the platform says it was delivered' },
  { from: ['ACCEPTED', 'PREPARING', 'READY'], to: 'PICKED_UP', by: ['aggregator'], when: (o) => o.fulfilment === 'PICKUP', note: 'the platform says the customer collected it' },
];

export type TransitionCheck = { ok: true } | { ok: false; reason: string };

/** Whether `actor` may move an order from `from` to `to`. Pure: used by the hub before every change, and by the apps to show buttons. */
export function canTransition(o: OrderFacts, from: OrderState, to: OrderState, actor: Actor): TransitionCheck {
  if (TERMINAL.includes(from)) return { ok: false, reason: `The order is already ${label(from).toLowerCase()}.` };
  const rules = TRANSITIONS.filter((r) => r.to === to && r.from.includes(from) && (!r.when || r.when(o)));
  if (!rules.length) return { ok: false, reason: `An order cannot go from ${label(from).toLowerCase()} to ${label(to).toLowerCase()}.` };
  if (!rules.some((r) => r.by.includes(actor))) return { ok: false, reason: `Only ${[...new Set(rules.flatMap((r) => r.by))].join(' or ')} can do this.` };
  return { ok: true };
}

/** The states `actor` can move the order to next (for showing buttons). */
export function nextStates(o: OrderFacts, from: OrderState, actor: Actor): OrderState[] {
  return ORDER_STATES.filter((to) => canTransition(o, from, to, actor).ok);
}

/** Does leaving this state toward `to` need a refund of an online payment? */
export function needsRefund(o: OrderFacts & { paid: boolean }, to: OrderState): boolean {
  return o.payment === 'ONLINE' && o.paid && (to === 'REJECTED' || to === 'AUTO_REJECTED' || to === 'CANCELLED');
}

/** What the customer sees. */
export function label(s: OrderState): string {
  return ({
    PLACED: 'Placed', PAYMENT_PENDING: 'Waiting for payment', PAYMENT_FAILED: 'Payment failed', SENT_TO_STORE: 'Sent to the store', RECEIVED: 'Received by the store',
    ACCEPTED: 'Accepted', REJECTED: 'Rejected by the store', AUTO_REJECTED: 'Not accepted in time', PREPARING: 'Being prepared', READY: 'Ready',
    OUT_FOR_DELIVERY: 'Out for delivery', DELIVERED: 'Delivered', PICKED_UP: 'Collected', CANCELLED: 'Cancelled',
  } as Record<OrderState, string>)[s];
}
