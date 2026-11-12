import assert from "node:assert/strict";
import { test } from "vitest";
import { licenceStatus, type LicencePayload, type Verified } from "./index.ts";

const day = 86_400_000;
const end = Date.parse("2027-01-31T00:00:00Z");
const ok = (features: string[] = []): Verified => ({
  ok: true, kid: "master",
  payload: { v: 1, licensee: "Spice Route", hardwareId: "X", issuedAt: "2026-01-31T00:00:00Z", expiresAt: new Date(end).toISOString(), seats: { terminals: 2 }, features } satisfies LicencePayload,
});
const at = (msFromEnd: number) => new Date(end + msFromEnd);

test("no key and a refused key are not usable", () => {
  assert.deepEqual(licenceStatus(null, new Date()), { state: "none", usable: false, trial: false });
  const refused = licenceStatus({ ok: false, code: "BAD_SIGNATURE", reason: "not genuine" }, new Date());
  assert.equal(refused.state, "invalid");
  assert.equal(refused.reason, "not genuine");
});

test("ok, then expiring in the last 15 days, then 7 days of grace, then expired", () => {
  assert.equal(licenceStatus(ok(), at(-16 * day)).state, "ok");
  const expiring = licenceStatus(ok(), at(-15 * day));
  assert.equal(expiring.state, "expiring");
  assert.equal(expiring.daysLeft, 15);
  const grace = licenceStatus(ok(), at(day));
  assert.equal(grace.state, "grace");
  assert.equal(grace.usable, true);
  assert.equal(grace.graceEndsAt, new Date(end + 7 * day).toISOString());
  const expired = licenceStatus(ok(), at(7 * day));
  assert.equal(expired.state, "expired");
  assert.equal(expired.usable, false);
});

test("a trial key warns only in its last 2 days; a custom policy is honoured", () => {
  assert.equal(licenceStatus(ok(["trial"]), at(-3 * day)).state, "ok");
  assert.equal(licenceStatus(ok(["trial"]), at(-2 * day)).state, "expiring");
  assert.equal(licenceStatus(ok(["trial"]), at(-3 * day)).trial, true);
  assert.equal(licenceStatus(ok(), at(day), { warnDays: 30, trialWarnDays: 3, graceDays: 0 }).state, "expired");
});
