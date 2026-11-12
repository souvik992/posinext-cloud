# Online order contract (v1)

This folder is the single definition shared by the order hub, the POS connector and the customer apps. Write it here first; then build against it (see `docs/ONLINE_ORDERS_PLAN.md`).

| File | What |
|---|---|
| `src/order.ts` | The order life cycle: states, every allowed change and who may make it (`canTransition`, `nextStates`, `needsRefund`, customer labels). |
| `src/types.ts` | Data shapes: `PlaceOrderRequest`, `Order`, `PosEvent`, `CustomerEvent`, `StoreOnlineSettings`. |
| `src/validate.ts` | `checkPlaceOrder`: what a customer may send (mobile, OTP rule for COD, address, cart). |
| `openapi.yaml` | Every endpoint, for the hub and any app developer. |

Tests: `test/contract_order.test.ts`, `test/contract_validate.test.ts`. They run with `npm test` in the repo root.

## Decisions built in (owner, 2026-10-15)

* **Events:** Server-Sent Events from the hub to the POS and to customer apps; HTTPS calls for actions. No polling.
* **Order types:** pickup and delivery. Delivery uses the store's own (in-house) riders; the rider's name and phone are recorded when the order goes out. Dine-in table QR comes later.
* **Payment:** online (gateway) and cash on delivery / at pickup (COD).
* **Customer:** name optional, mobile required. Sign in with an OTP, or check out as a guest. COD needs an OTP-verified mobile (stops fake COD orders); guests pay online.
* **Accepting:** set per store in the POS (Settings > Online orders).
  * Manual: the hub auto-rejects after N minutes (default 5, 2 to 15), with a refund if the order was paid.
  * Auto-accept: the POS accepts and bills each order the moment it arrives.

## Events

**Hub to POS** (`GET /v1/pos/events`, SSE, resumable with `Last-Event-ID`):

| Event | When | POS does |
|---|---|---|
| `order.created` | An order is ready for the store (COD placed, or online payment captured) | Stores it (idempotent by order id), confirms with `/received`. Manual mode: shows it in ODS "New" with a sound alert. Auto mode: makes the bill and calls `/accept`. |
| `order.cancelled` | The customer cancelled before acceptance | Removes it from New and tells the cashier |
| `order.auto_rejected` | Manual mode: no answer in time | Removes it from New, shows "missed" |
| `order.updated` | Another counter of the same store moved the order on | Updates its screen (first accept wins: F12) |

The hub also sends a heartbeat (`: ping`) every 15 s.

**Hub to customer** (`GET /v1/orders/{id}/events`): `order.state` with the label, ETA and rider. When the app is closed, a push notification is sent instead.

## Rules that never change in v1

1. Amounts are integer paise; the POS bill is the legal record. The hub's totals are what the customer was shown.
2. Every action has an `Idempotency-Key`; every event has a `seq`. Retries and replays are always safe.
3. The order life cycle in `src/order.ts` is enforced by the hub. The apps use it only to decide which buttons to show.
4. New fields may be added in v1; nothing is removed or renamed. A breaking change is v2.
