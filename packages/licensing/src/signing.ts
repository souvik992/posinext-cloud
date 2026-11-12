// Signing and public keys: PEM private keys (PKCS#8) on the signing server, base64 SPKI public keys in the products.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";

/** A signing key from PEM text, or from a file holding it. Only Ed25519 keys are accepted. */
export function loadSigningKey(pemOrPath: string): KeyObject {
  const pem = pemOrPath.includes("-----BEGIN") ? pemOrPath : readFileSync(pemOrPath, "utf8");
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("A licence signing key must be an Ed25519 private key.");
  return key;
}

/** The public half as base64 SPKI DER: the form products keep in their source code. */
export function publicKeyBase64(key: KeyObject): string {
  return createPublicKey(key).export({ format: "der", type: "spki" }).toString("base64");
}

export function publicKeyFromBase64(spkiBase64: string): KeyObject {
  const key = createPublicKey({ key: Buffer.from(spkiBase64, "base64"), format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ed25519") throw new Error("A licence public key must be an Ed25519 key.");
  return key;
}

/** A new key pair: the private half as PEM (keep it off customer machines), the public half for the products. */
export function generateSigningKeyPair(): { privateKeyPem: string; publicKeyBase64: string } {
  const { privateKey } = generateKeyPairSync("ed25519");
  return { privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(), publicKeyBase64: publicKeyBase64(privateKey) };
}

/** SHA-256 (hex) of a key's text, whitespace removed: finds a key in records without matching on the text itself. */
export function keyHash(keyText: string): string {
  return createHash("sha256").update(keyText.replace(/\s+/g, "")).digest("hex");
}
