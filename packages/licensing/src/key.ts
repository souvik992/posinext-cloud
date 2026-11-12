// Licence keys: a JSON payload signed with an Ed25519 private key, written as `<base64url payload>.<base64url signature>`.
// The product holds only public keys and checks a key offline. This is the format the Fine Dine (DinePOS) app has
// shipped since its first licence (payload version 1); every key issued before this module still verifies.
import { sign, verify, type KeyObject } from "node:crypto";

export const PAYLOAD_VERSION = 1;
const DAY_MS = 86_400_000;

/** Seats per kind of device, e.g. Fine Dine `{ terminals, captains, kds }`. Whole numbers, 0 or more. */
export type Seats = Record<string, number>;

/** What a key says. Field names are part of the key format: never rename them. */
export interface LicencePayload {
  v: 1;
  licensee: string;
  /** The PC (or hosted outlet) the key is for; see `formatHardwareId`. */
  hardwareId: string;
  issuedAt: string;
  expiresAt: string;
  seats: Seats;
  /** Feature flags. `trial` marks a trial or demo key. */
  features: string[];
  /** Which trusted key signed it. Missing on the oldest keys: they were all signed by `master`. */
  kid?: string;
  /** The outlet the key was issued for (informational). */
  outletId?: string;
  /** The product code (`fine_dine`, `tiffin_qsr`, ...). Missing on keys made before products were labelled. */
  product?: string;
}

/**
 * A public key a product trusts. `maxDays` limits how long a key it signs may last, so a leaked online signing key
 * cannot mint long licences (the offline `master` key has no limit).
 */
export interface TrustedKey {
  id: string;
  publicKey: KeyObject;
  maxDays?: number;
}

export interface ParsedKey {
  payload: LicencePayload;
  /** The exact signed bytes (the decoded payload part). */
  signed: Buffer;
  signature: Buffer;
}

export type RejectCode = "MALFORMED" | "UNKNOWN_SIGNER" | "BAD_SIGNATURE" | "TOO_LONG" | "OTHER_HARDWARE" | "OTHER_PRODUCT";
export type Verified = { ok: true; payload: LicencePayload; kid: string } | { ok: false; code: RejectCode; reason: string };

const isSeats = (value: unknown): value is Seats =>
  typeof value === "object" && value !== null && !Array.isArray(value) &&
  Object.values(value).every((n) => Number.isInteger(n) && (n as number) >= 0);

/** Reads a key without checking its signature. Spaces and line breaks (from e-mail or chat) are ignored. */
export function parseKey(raw: string): ParsedKey | null {
  const parts = raw.replace(/\s+/g, "").split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  try {
    const signed = Buffer.from(parts[0], "base64url");
    const payload = JSON.parse(signed.toString("utf8")) as LicencePayload;
    if (payload?.v !== PAYLOAD_VERSION) return null;
    if (typeof payload.hardwareId !== "string" || typeof payload.licensee !== "string") return null;
    if (typeof payload.issuedAt !== "string" || typeof payload.expiresAt !== "string" || Number.isNaN(Date.parse(payload.expiresAt))) return null;
    if (!isSeats(payload.seats)) return null;
    return { payload, signed, signature: Buffer.from(parts[1], "base64url") };
  } catch {
    return null;
  }
}

export interface SignInput {
  /** Id of the signing key, written into the payload (`kid`). */
  kid: string;
  licensee: string;
  hardwareId: string;
  issuedAt: Date;
  expiresAt: Date;
  seats: Seats;
  features?: readonly string[];
  outletId?: string;
  product?: string;
}

/** Signs a key. Checks only the shape of the input; who may get a key, and for how long, is the caller's decision. */
export function signKey(input: SignInput, privateKey: KeyObject): string {
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Licence keys are signed with an Ed25519 private key.");
  if (!input.kid.trim()) throw new Error("kid is required.");
  if (!input.licensee.trim()) throw new Error("licensee is required.");
  if (!(input.expiresAt.getTime() > input.issuedAt.getTime())) throw new Error("expiresAt must be after issuedAt.");
  if (!isSeats(input.seats)) throw new Error("seats must be whole numbers, 0 or more.");
  const payload: LicencePayload = {
    v: PAYLOAD_VERSION,
    kid: input.kid,
    licensee: input.licensee,
    hardwareId: input.hardwareId,
    issuedAt: input.issuedAt.toISOString(),
    expiresAt: input.expiresAt.toISOString(),
    seats: { ...input.seats },
    features: [...new Set(input.features ?? [])],
    ...(input.outletId === undefined ? {} : { outletId: input.outletId }),
    ...(input.product === undefined ? {} : { product: input.product }),
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  return `${body.toString("base64url")}.${sign(null, body, privateKey).toString("base64url")}`;
}

export interface VerifyOptions {
  /** Refuse keys labelled for another product. Unlabelled (older) keys are accepted unless `requireProduct`. */
  product?: string;
  requireProduct?: boolean;
}

/**
 * Checks the signature (by a trusted key, within that key's `maxDays`), the PC and the product. Expiry is not judged
 * here: see `licenceStatus`, so an expired key still shows who it was for and when it ended.
 */
export function verifyKey(raw: string, trusted: readonly TrustedKey[], hardwareId: string, options: VerifyOptions = {}): Verified {
  const parsed = parseKey(raw);
  if (!parsed) return { ok: false, code: "MALFORMED", reason: "This is not a licence key. Paste the whole key you were sent." };
  const { payload } = parsed;
  const kid = payload.kid ?? "master";
  const signer = trusted.find((k) => k.id === kid);
  if (!signer) return { ok: false, code: "UNKNOWN_SIGNER", reason: "This licence key was signed by a key this product does not trust." };
  if (!verify(null, parsed.signed, signer.publicKey, parsed.signature)) {
    return { ok: false, code: "BAD_SIGNATURE", reason: "This licence key is not genuine (its signature does not match)." };
  }
  if (signer.maxDays !== undefined) {
    const span = Date.parse(payload.expiresAt) - Date.parse(payload.issuedAt);
    if (Number.isNaN(span) || span > signer.maxDays * DAY_MS) {
      return { ok: false, code: "TOO_LONG", reason: `This licence key is not valid: keys from this signer last at most ${signer.maxDays} days.` };
    }
  }
  if (payload.hardwareId !== hardwareId) {
    return { ok: false, code: "OTHER_HARDWARE", reason: `This licence key is for another computer (${payload.hardwareId}); this one is ${hardwareId}.` };
  }
  if (options.product !== undefined) {
    if (payload.product === undefined ? options.requireProduct === true : payload.product !== options.product) {
      return { ok: false, code: "OTHER_PRODUCT", reason: "This licence key is for another product." };
    }
  }
  return { ok: true, payload, kid };
}
