/**
 * SMS codes through MSG91 (India: every SMS goes out on a DLT-approved template). One template serves every code the
 * hub sends (order OTP, portal sign-in code, mobile verification), e.g. "##otp## is your PosiNext code. It expires in
 * 10 minutes." with the variable named by HUB_MSG91_OTP_VAR (default `otp`).
 *   HUB_MSG91_AUTH_KEY     the account's auth key (MSG91 > API)
 *   HUB_MSG91_TEMPLATE_ID  the flow template's id (MSG91 > SMS > Templates / Flows)
 *   HUB_MSG91_OTP_VAR      the template variable that holds the code (default otp)
 * Not set: no SMS is sent (codes are only logged, masked) and the SMS checks cannot be switched on.
 */

/** Sends `code` to `mobile`. `text` is the full message, for providers that take free text (and for logs/tests). */
export type SendSms = (mobile: string, text: string, code: string) => Promise<void>;

export interface Msg91Options { authKey: string; templateId: string; otpVar?: string; fetch?: typeof fetch; url?: string }

/** MSG91 wants the country code without '+': 10-digit Indian numbers get 91 in front. */
export function msg91Number(mobile: string): string {
  const d = mobile.replace(/\D/g, '');
  return d.length === 10 ? `91${d}` : d;
}

export function msg91(o: Msg91Options): SendSms {
  const f = o.fetch ?? fetch;
  return async (mobile, _text, code) => {
    const r = await f(o.url ?? 'https://control.msg91.com/api/v5/flow', {
      method: 'POST',
      headers: { authkey: o.authKey, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ template_id: o.templateId, short_url: '0', recipients: [{ mobiles: msg91Number(mobile), [o.otpVar || 'otp']: code }] }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await r.text();
    let ok = r.ok;
    try { if ((JSON.parse(body) as { type?: string }).type === 'error') ok = false; } catch { /* not JSON: go by the status */ }
    if (!ok) throw new Error(`MSG91 refused the SMS (${r.status}): ${body.slice(0, 200)}`);
  };
}

export function smsFromEnv(env: Record<string, string | undefined>): SendSms | undefined {
  if (!env.HUB_MSG91_AUTH_KEY || !env.HUB_MSG91_TEMPLATE_ID) return undefined;
  return msg91({ authKey: env.HUB_MSG91_AUTH_KEY, templateId: env.HUB_MSG91_TEMPLATE_ID, otpVar: env.HUB_MSG91_OTP_VAR });
}
