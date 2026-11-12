# @dinepos/licensing

Licence keys for every product on the platform: a JSON payload signed with an Ed25519 private key, checked offline
by the product with the public key. No runtime dependencies (Node's `crypto` only). Used by PosiNext Cloud for every product (ADR-0007).

The format is the one the DinePOS app has shipped since its first licence, so every key issued before this
module still verifies, and keys made here verify in the shipped app (`src/test-fixtures/compat.json` holds keys and
hardware ids made by the app's own code; the tests check both directions).

## Key format

```
<base64url(JSON payload)>.<base64url(Ed25519 signature of those bytes)>
```

| Field | Meaning |
|---|---|
| `v` | Always `1`. |
| `kid` | Which trusted key signed it. Missing on the oldest keys: they are `master`'s. |
| `licensee` | Who it is for (shown in the product). |
| `hardwareId` | The PC: `AB12-CD34-EF56-7890-1A2B` (`formatHardwareId`). A key works on that PC only. |
| `issuedAt`, `expiresAt` | ISO times. |
| `seats` | Devices per kind, e.g. Fine Dine `{ terminals, captains, kds }` (all three required by that app). |
| `features` | Flags. `trial` marks a trial or demo key. |
| `outletId` | Informational. |
| `product` | Product code (`fine_dine`, `tiffin_qsr`, ...). Missing on keys made before products were labelled. |

Field names are part of the format: never rename them, only add optional ones.

## Use

```ts
import { loadSigningKey, publicKeyFromBase64, signKey, verifyKey, licenceStatus, hardwareId } from "@dinepos/licensing";

// signing server
const key = signKey({ kid: "cloud", licensee: "Spice Route", hardwareId: "AB12-CD34-EF56-7890-1A2B",
  issuedAt: new Date(), expiresAt: new Date(Date.now() + 14 * 86_400_000),
  seats: { terminals: 1, captains: 1, kds: 1 }, features: ["trial"], product: "fine_dine" }, loadSigningKey(pemFile));

// product (offline)
const trusted = [
  { id: "master", publicKey: publicKeyFromBase64(MASTER) },              // vendor's offline key: no limit
  { id: "cloud", publicKey: publicKeyFromBase64(CLOUD), maxDays: 400 },  // online signer: short keys only
];
const verified = verifyKey(pasted, trusted, hardwareId(), { product: "fine_dine" });
const status = licenceStatus(verified, new Date()); // ok | expiring | grace | expired | invalid | none
```

`verifyKey` refuses with a code: `MALFORMED`, `UNKNOWN_SIGNER`, `BAD_SIGNATURE`, `TOO_LONG` (longer than the signer's
`maxDays`), `OTHER_HARDWARE`, `OTHER_PRODUCT`. Expiry is judged by `licenceStatus` (default policy: warn 15 days before
the end, trial keys 2 days; 7 days of grace after it).

## Keys
- `generateSigningKeyPair()` makes a new pair. Keep the private PEM on the signing server only; products embed the
  public base64.
- A signer trusted with `maxDays` cannot mint long keys even if its private key leaks. Keep a `master` key offline.
- If an online signing key leaks: ship product builds that trust a new one under a new `kid`.

## Develop

`npm run test -w @dinepos/licensing` (vitest). PosiNext Cloud (`cloud/hub`) imports `src/index.ts` directly: Node runs
the source, so relative imports end in `.ts` and the code uses only erasable TypeScript (no enums, no parameter
properties). `tsc -b` writes `dist/` for workspace packages that import `@dinepos/licensing`.
