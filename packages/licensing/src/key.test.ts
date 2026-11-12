import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { generateSigningKeyPair, keyHash, loadSigningKey, parseKey, publicKeyFromBase64, signKey, verifyKey, type TrustedKey } from "./index.ts";

const fixtures = JSON.parse(readFileSync(new URL("./test-fixtures/compat.json", import.meta.url), "utf8")) as {
  masterPublicKey: string; cloudPublicKey: string; hardwareId: string; legacyKey: string; cloudKey: string;
};
// keys made by the Fine Dine app's code (fixtures: public halves only)
const shipped: TrustedKey[] = [
  { id: "master", publicKey: publicKeyFromBase64(fixtures.masterPublicKey) },
  { id: "cloud", publicKey: publicKeyFromBase64(fixtures.cloudPublicKey), maxDays: 400 },
];
// keys made here, by a pair made for this run
const pair = generateSigningKeyPair();
const cloudSigner = loadSigningKey(pair.privateKeyPem);
const trusted: TrustedKey[] = [shipped[0]!, { id: "cloud", publicKey: publicKeyFromBase64(pair.publicKeyBase64), maxDays: 400 }];
const hw = fixtures.hardwareId;
const day = 86_400_000;
const issue = (over: Partial<Parameters<typeof signKey>[0]> = {}) =>
  signKey({ kid: "cloud", licensee: "Spice Route", hardwareId: hw, issuedAt: new Date("2026-11-01T00:00:00Z"), expiresAt: new Date("2026-11-15T00:00:00Z"), seats: { terminals: 1, captains: 1, kds: 1 }, features: ["trial"], product: "fine_dine", ...over }, cloudSigner);

test("keys made by the Fine Dine keygen (no kid) still verify, as the master key's", () => {
  const v = verifyKey(fixtures.legacyKey, shipped, hw);
  assert.equal(v.ok, true);
  assert.equal(v.ok && v.kid, "master");
  assert.deepEqual(v.ok && v.payload.seats, { terminals: 2, captains: 2, kds: 1 });
});

test("keys made by PosiNext Cloud still verify, and unlabelled keys pass a product check", () => {
  const v = verifyKey(fixtures.cloudKey, shipped, hw, { product: "fine_dine" });
  assert.equal(v.ok && v.kid, "cloud");
  assert.equal(verifyKey(fixtures.cloudKey, shipped, hw, { product: "fine_dine", requireProduct: true }).ok, false);
  assert.equal(verifyKey(fixtures.cloudKey, trusted, hw).ok, false, "another cloud key pair must not verify it");
});

test("a key this module signs round-trips with its product label; spaces and line breaks are ignored", () => {
  const key = issue();
  const spaced = key.replace(/(.{40})/g, "$1\n  ");
  const v = verifyKey(spaced, trusted, hw, { product: "fine_dine", requireProduct: true });
  assert.equal(v.ok, true);
  assert.equal(v.ok && v.payload.product, "fine_dine");
  assert.equal(keyHash(spaced), keyHash(key));
});

test("refusals say why: tampered, unknown signer, too long for the signer, another PC, another product, not a key", () => {
  const key = issue();
  const [body, sig] = key.split(".") as [string, string];
  const tampered = Buffer.from(Buffer.from(body, "base64url").toString("utf8").replace('"terminals":1', '"terminals":9')).toString("base64url");
  assert.equal(verifyKey(`${tampered}.${sig}`, trusted, hw).ok === false && (verifyKey(`${tampered}.${sig}`, trusted, hw) as { code: string }).code, "BAD_SIGNATURE");
  const code = (raw: string, opts = {}, onHw = hw) => { const v = verifyKey(raw, trusted, onHw, opts); return v.ok ? "ok" : v.code; };
  assert.equal(code(issue({ kid: "someone" })), "UNKNOWN_SIGNER");
  assert.equal(code(issue({ expiresAt: new Date(Date.parse("2026-11-01T00:00:00Z") + 401 * day) })), "TOO_LONG");
  assert.equal(code(issue({ expiresAt: new Date(Date.parse("2026-11-01T00:00:00Z") + 400 * day) })), "ok");
  assert.equal(code(key, {}, "0000-0000-0000-0000-0000"), "OTHER_HARDWARE");
  assert.equal(code(key, { product: "tiffin_qsr" }), "OTHER_PRODUCT");
  assert.equal(code("hello.world"), "MALFORMED");
  assert.equal(code(""), "MALFORMED");
});

test("a key signed by another key pair under a trusted kid is refused", () => {
  const other = loadSigningKey(generateSigningKeyPair().privateKeyPem);
  const forged = signKey({ kid: "master", licensee: "X", hardwareId: hw, issuedAt: new Date(), expiresAt: new Date(Date.now() + day), seats: { terminals: 1 } }, other);
  const v = verifyKey(forged, trusted, hw);
  assert.equal(v.ok === false && v.code, "BAD_SIGNATURE");
});

test("parseKey reads the payload; signKey refuses bad input", () => {
  assert.equal(parseKey(issue())?.payload.licensee, "Spice Route");
  assert.equal(parseKey(`${Buffer.from(JSON.stringify({ v: 2 })).toString("base64url")}.x`), null);
  assert.equal(parseKey(`${Buffer.from(JSON.stringify({ v: 1, licensee: "a", hardwareId: hw, issuedAt: "x", expiresAt: "2027-01-01", seats: { terminals: -1 } })).toString("base64url")}.x`), null);
  assert.throws(() => issue({ expiresAt: new Date("2026-10-01T00:00:00Z") }), /after issuedAt/);
  assert.throws(() => issue({ seats: { terminals: 1.5 } }), /whole numbers/);
  assert.throws(() => issue({ licensee: " " }), /licensee/);
});
