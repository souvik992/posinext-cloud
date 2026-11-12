/**
 * Hub settings the admin page can change while the hub runs. Saved in the hub database (table `setting`); a setting
 * never saved uses its default (from the environment where one exists, e.g. HUB_ROUTING_URL).
 * Not here on purpose: HUB_DEV_OTP and HUB_ONLINE_PAYMENTS. Showing OTP codes would let anyone with the admin key skip
 * mobile checks, and online payment needs a payment gateway; both stay environment-only.
 */

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
}

export const SETTING_DEFAULTS: HubSettings = { routingUrl: '', offlineAfterSec: 60, pairingCodeMinutes: 30, otpPerMinute: 5, ordersPerMinute: 20, pairPerMinute: 10 };

const RANGES: Record<Exclude<keyof HubSettings, 'routingUrl'>, [number, number, string]> = {
  offlineAfterSec: [15, 3600, 'Offline after must be 15 to 3600 seconds.'],
  pairingCodeMinutes: [5, 1440, 'Pairing codes must be valid 5 to 1440 minutes.'],
  otpPerMinute: [1, 100, 'OTP requests must be 1 to 100 per minute.'],
  ordersPerMinute: [1, 1000, 'Orders must be 1 to 1000 per minute.'],
  pairPerMinute: [1, 100, 'Pairing attempts must be 1 to 100 per minute.'],
};

/** Checks a partial update. Unknown fields are refused so a typo is never silently ignored. */
export function checkSettings(input: unknown): { ok: true; value: Partial<HubSettings> } | { ok: false; errors: Record<string, string> } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: { _: 'Send the settings to change.' } };
  const errors: Record<string, string> = {};
  const value: Partial<HubSettings> = {};
  for (const [k, v] of Object.entries(input)) {
    if (k === 'routingUrl') {
      const url = typeof v === 'string' ? v.trim().replace(/\/+$/, '') : null;
      if (url === null || url.length > 300 || (url && !/^https?:\/\/[^\s/]+/.test(url))) errors[k] = 'The routing server must be an http:// or https:// address, or empty.';
      else value.routingUrl = url;
    } else if (k in RANGES) {
      const [min, max, msg] = RANGES[k as keyof typeof RANGES];
      if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) errors[k] = msg;
      else value[k as keyof typeof RANGES] = v as number;
    } else errors[k] = 'Unknown setting.';
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value };
}
