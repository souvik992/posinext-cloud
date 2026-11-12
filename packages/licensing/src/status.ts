// What a verified key means at a moment in time: fine, ending soon, in grace after its end, or over.
import type { Seats, Verified } from "./key.ts";

export type LicenceState = "none" | "invalid" | "ok" | "expiring" | "grace" | "expired";

export interface LicencePolicy {
  /** Warn this many days before the end. */
  warnDays: number;
  /** Trial keys (feature `trial`) warn only in their last days: the whole trial is shorter than `warnDays`. */
  trialWarnDays: number;
  /** Keeps working this many days after the end, loudly. */
  graceDays: number;
}

/** The policy the Fine Dine app has used since its first licence. */
export const DEFAULT_POLICY: LicencePolicy = { warnDays: 15, trialWarnDays: 2, graceDays: 7 };

export interface LicenceStatus {
  state: LicenceState;
  /** May the product keep working (start a new business day)? True for ok, expiring and grace. */
  usable: boolean;
  trial: boolean;
  licensee?: string;
  expiresAt?: string;
  /** Whole days until the end (negative after it). */
  daysLeft?: number;
  graceEndsAt?: string;
  seats?: Seats;
  /** Why the key was refused (state `invalid`). */
  reason?: string;
}

const DAY_MS = 86_400_000;

export function licenceStatus(verified: Verified | null, now: Date, policy: LicencePolicy = DEFAULT_POLICY): LicenceStatus {
  if (!verified) return { state: "none", usable: false, trial: false };
  if (!verified.ok) return { state: "invalid", usable: false, trial: false, reason: verified.reason };
  const p = verified.payload;
  const end = Date.parse(p.expiresAt);
  const trial = Array.isArray(p.features) && p.features.includes("trial");
  const base = { trial, licensee: p.licensee, expiresAt: p.expiresAt, daysLeft: Math.ceil((end - now.getTime()) / DAY_MS), seats: p.seats };
  if (now.getTime() < end) {
    const warn = trial ? policy.trialWarnDays : policy.warnDays;
    return { ...base, state: base.daysLeft <= warn ? "expiring" : "ok", usable: true };
  }
  const graceEndsAt = new Date(end + policy.graceDays * DAY_MS).toISOString();
  return { ...base, graceEndsAt, state: now.getTime() < Date.parse(graceEndsAt) ? "grace" : "expired", usable: now.getTime() < Date.parse(graceEndsAt) };
}
