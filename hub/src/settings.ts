/**
 * Hub settings the admin page can change while the hub runs. Saved in the hub database (table `setting`); a setting
 * never saved uses its default (from the environment where one exists, e.g. HUB_ROUTING_URL).
 * Not here on purpose: HUB_DEV_OTP and HUB_ONLINE_PAYMENTS. Showing OTP codes would let anyone with the admin key skip
 * mobile checks, and online payment needs a payment gateway; both stay environment-only.
 */

/**
 * Security checks, each switched on per channel (the admin page's "Security checks" grid):
 *   portal        the customer website (portal address): sign-up, sign-in
 *   orderingApp   the food ordering app (orders with channel "app")
 *   orderingSite  the food ordering website (orders with channel "website")
 * captcha             portal: sign-in, sign-up and code sign-in; ordering: before an SMS code is sent, and before an order
 *                     that was not confirmed by an SMS code
 * otp                 sign in with an SMS code. Portal: "Sign in with a code" (accounts with a confirmed mobile); ordering:
 *                     the customer confirms their mobile with a code before a cash-on-delivery order
 * emailVerification   portal: a new account confirms its email with a code (every customer account, on any address)
 * mobileVerification  portal: the account's mobile number is confirmed with an SMS code before the first sign-in
 */
export const CHANNELS = ['portal', 'orderingApp', 'orderingSite'] as const;
export type Channel = typeof CHANNELS[number];
export const CHECKS = ['captcha', 'otp', 'emailVerification', 'mobileVerification'] as const;
export type Check = typeof CHECKS[number];
export type Checks = Record<Check, Record<Channel, boolean>>;
/** Where each check means something; the other boxes are always off. */
export const CHECK_CHANNELS: Record<Check, readonly Channel[]> = {
  captcha: CHANNELS, otp: CHANNELS, emailVerification: ['portal'], mobileVerification: ['portal'],
};
/** Checks that send an SMS: they need an SMS provider (or HUB_DEV_OTP) before they can be switched on. */
export const SMS_CHECKS: ReadonlyArray<[Check, Channel]> = [['otp', 'portal'], ['mobileVerification', 'portal']];

const DEFAULT_CHECKS: Checks = {
  captcha: { portal: false, orderingApp: false, orderingSite: false },
  otp: { portal: false, orderingApp: true, orderingSite: true }, // ordering: cash on delivery needed the code before
  emailVerification: { portal: true, orderingApp: false, orderingSite: false },
  mobileVerification: { portal: false, orderingApp: false, orderingSite: false },
};

/** A full set of checks: missing boxes from `base`, boxes that do not apply always off. */
export function fullChecks(input: unknown, base: Checks = DEFAULT_CHECKS): Checks {
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, Record<string, unknown> | undefined>;
  const out = {} as Checks;
  for (const k of CHECKS) {
    out[k] = {} as Record<Channel, boolean>;
    for (const ch of CHANNELS) out[k][ch] = CHECK_CHANNELS[k].includes(ch) && (typeof src[k]?.[ch] === 'boolean' ? src[k]![ch] as boolean : base[k][ch]);
  }
  return out;
}

/** The order channel of the contract ("app" | "website") as a settings channel. */
export const orderingChannel = (c: 'app' | 'website'): Channel => (c === 'app' ? 'orderingApp' : 'orderingSite');

export interface HubSettings {
  /** OSRM-compatible road-routing server; empty: straight line x each store's road factor. */
  routingUrl: string;
  /** A store counts as offline this long after its last POS event stream closed (F8). */
  offlineAfterSec: number;
  pairingCodeMinutes: number;
  /** Requests per minute per IP address. */
  otpPerMinute: number;
  ordersPerMinute: number;
  pairPerMinute: number;
  /** Captcha, OTP, email and mobile verification per channel (above). */
  checks: Checks;
}

export const SETTING_DEFAULTS: HubSettings = { routingUrl: '', offlineAfterSec: 60, pairingCodeMinutes: 30, otpPerMinute: 5, ordersPerMinute: 20, pairPerMinute: 10, checks: DEFAULT_CHECKS };

const RANGES: Record<Exclude<keyof HubSettings, 'routingUrl' | 'checks'>, [number, number, string]> = {
  offlineAfterSec: [15, 3600, 'Offline after must be 15 to 3600 seconds.'],
  pairingCodeMinutes: [5, 1440, 'Pairing codes must be valid 5 to 1440 minutes.'],
  otpPerMinute: [1, 100, 'OTP requests must be 1 to 100 per minute.'],
  ordersPerMinute: [1, 1000, 'Orders must be 1 to 1000 per minute.'],
  pairPerMinute: [1, 100, 'Pairing attempts must be 1 to 100 per minute.'],
};

/**
 * Checks a partial update. Unknown fields are refused so a typo is never silently ignored. `checks` may be partial
 * ({ captcha: { portal: true } }); it is merged into the current checks by the hub.
 */
export function checkSettings(input: unknown): { ok: true; value: Omit<Partial<HubSettings>, 'checks'> & { checks?: Partial<Record<Check, Partial<Record<Channel, boolean>>>> } } | { ok: false; errors: Record<string, string> } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: { _: 'Send the settings to change.' } };
  const errors: Record<string, string> = {};
  const value: Omit<Partial<HubSettings>, 'checks'> & { checks?: Partial<Record<Check, Partial<Record<Channel, boolean>>>> } = {};
  for (const [k, v] of Object.entries(input)) {
    if (k === 'routingUrl') {
      const url = typeof v === 'string' ? v.trim().replace(/\/+$/, '') : null;
      if (url === null || url.length > 300 || (url && !/^https?:\/\/[^\s/]+/.test(url))) errors[k] = 'The routing server must be an http:// or https:// address, or empty.';
      else value.routingUrl = url;
    } else if (k === 'checks') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) { errors[k] = 'Send the checks as { check: { channel: true or false } }.'; continue; }
      const checks: Partial<Record<Check, Partial<Record<Channel, boolean>>>> = {};
      for (const [ck, chans] of Object.entries(v)) {
        if (!(CHECKS as readonly string[]).includes(ck) || !chans || typeof chans !== 'object' || Array.isArray(chans)) { errors[`checks.${ck}`] = 'Unknown check.'; continue; }
        for (const [ch, on] of Object.entries(chans)) {
          const where = `checks.${ck}.${ch}`;
          if (!(CHANNELS as readonly string[]).includes(ch)) errors[where] = 'Unknown channel.';
          else if (typeof on !== 'boolean') errors[where] = 'Must be true or false.';
          else if (on && !CHECK_CHANNELS[ck as Check].includes(ch as Channel)) errors[where] = 'This check does not apply to this channel.';
          else (checks[ck as Check] ??= {})[ch as Channel] = on;
        }
      }
      value.checks = checks;
    } else if (k in RANGES) {
      const [min, max, msg] = RANGES[k as keyof typeof RANGES];
      if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) errors[k] = msg;
      else value[k as keyof typeof RANGES] = v as number;
    } else errors[k] = 'Unknown setting.';
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value };
}
