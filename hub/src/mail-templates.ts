/**
 * The emails the hub sends to customers, editable on the admin page (Hub settings > Email templates) and saved as the
 * setting "mailTemplates" (only the ones changed from the default). Each has a subject, a plain-text body, and an HTML
 * version (html; "" = plain text only). Both go out together (multipart/alternative): mail apps show the HTML, and
 * the text where HTML is off. {{name}} is replaced when sent (HTML-escaped in the HTML version).
 */

export interface MailTemplate { subject: string; body: string; html: string }

/** The default design: one table-based, inline-styled layout that mail apps (Gmail, Outlook, phones) all show alike. */
const BRAND = '#f15b00';
function layout(preheader: string, inner: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>PosiNext</title></head>
<body style="margin:0;padding:0;background:#f4f1ec;font-family:Arial,Helvetica,sans-serif;color:#1f2430">
<div style="display:none;max-height:0;overflow:hidden">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1ec;padding:24px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e8e1d8">
<tr><td style="background:#101a2c;padding:18px 28px;font-size:20px;font-weight:bold;letter-spacing:.5px;color:#ffffff"><span style="color:${BRAND}">&rsaquo;&rsaquo;</span> POSINEXT</td></tr>
<tr><td style="padding:28px 28px 8px;font-size:15px;line-height:1.6">
${inner}
</td></tr>
<tr><td style="padding:18px 28px 24px;font-size:12px;line-height:1.5;color:#7a7f8a;border-top:1px solid #eee8e0">PosiNext · Restaurant POS and online ordering · <a href="https://posinext.com" style="color:#7a7f8a">posinext.com</a><br>This email was sent because of an action on your PosiNext account.</td></tr>
</table>
</td></tr></table>
</body></html>`;
}
const codeBox = '<div style="margin:18px 0;padding:16px;background:#fff4ec;border:1px dashed ' + BRAND + ';border-radius:10px;text-align:center;font-size:32px;font-weight:bold;letter-spacing:8px;color:#1f2430">{{code}}</div>';

interface TemplateInfo extends MailTemplate {
  label: string;
  hint: string;
  /** The {{names}} the template can use, with an example value (the preview and the test email use them). */
  vars: Record<string, string>;
  /** Names the template must use (an email without the code is no use). */
  required: string[];
}

export const MAIL_TEMPLATES = {
  verify: {
    label: 'Email verification code',
    hint: 'Sent when someone signs up on the portal (Security checks > Email verification), and when they ask for a new code.',
    vars: { code: '482913', minutes: '10' },
    required: ['code'],
    subject: '{{code}} is your PosiNext code',
    body: 'Your PosiNext verification code is {{code}}.\n\nIt works for {{minutes}} minutes. If you did not sign up for PosiNext, ignore this email.',
    html: layout('Your PosiNext verification code is {{code}}',
      '<h1 style="margin:0 0 8px;font-size:22px;color:#101a2c">Confirm your email</h1>\n<p style="margin:0">Enter this code on PosiNext to finish signing up:</p>\n' + codeBox +
      '\n<p style="margin:0 0 16px;color:#555b66">It works for {{minutes}} minutes. If you did not sign up for PosiNext, ignore this email.</p>'),
  },
  reset: {
    label: 'Password reset code',
    hint: 'Sent when someone presses "Forgot password" on the portal.',
    vars: { code: '482913', minutes: '10' },
    required: ['code'],
    subject: 'Reset your PosiNext password',
    body: 'Your PosiNext password reset code is {{code}}.\n\nIt works for {{minutes}} minutes. If you did not ask to reset your password, ignore this email: your password stays the same.',
    html: layout('Your PosiNext password reset code is {{code}}',
      '<h1 style="margin:0 0 8px;font-size:22px;color:#101a2c">Reset your password</h1>\n<p style="margin:0">Enter this code on PosiNext to choose a new password:</p>\n' + codeBox +
      '\n<p style="margin:0 0 16px;color:#555b66">It works for {{minutes}} minutes. If you did not ask to reset your password, ignore this email: your password stays the same.</p>'),
  },
  ticketReply: {
    label: 'Support ticket answer',
    hint: 'Sent to the customer who opened a ticket when you answer it (Support).',
    vars: { reply: 'Thanks for writing in. The printer setting is under Settings > Printers.', staffName: 'Support team', ticketNumber: '42', ticketSubject: 'Printer not printing KOTs' },
    required: ['reply'],
    subject: 'Re: [Ticket #{{ticketNumber}}] {{ticketSubject}}',
    body: '{{reply}}\n\n— {{staffName}}\n\nSee the whole conversation and reply in your client area: Support tickets › #{{ticketNumber}}.',
    html: layout('Ticket #{{ticketNumber}}: {{ticketSubject}}',
      '<p style="margin:0 0 6px;font-size:13px;color:#7a7f8a">Ticket #{{ticketNumber}} · {{ticketSubject}}</p>\n<div style="margin:0 0 16px">{{reply}}</div>\n<p style="margin:0 0 18px">— {{staffName}}</p>\n' +
      '<p style="margin:0 0 16px"><a href="https://portal.posinext.com/support" style="display:inline-block;background:' + BRAND + ';color:#ffffff;text-decoration:none;font-weight:bold;padding:11px 18px;border-radius:8px">See the conversation and reply</a></p>'),
  },
} satisfies Record<string, TemplateInfo>;

export type MailTemplateId = keyof typeof MAIL_TEMPLATES;
export type MailTemplates = Record<MailTemplateId, MailTemplate>;
export const MAIL_TEMPLATE_IDS = Object.keys(MAIL_TEMPLATES) as MailTemplateId[];

const VAR = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
const SUBJECT_MAX = 200, BODY_MAX = 5000, HTML_MAX = 60_000;

/** The saved templates over the defaults (one not saved, or saved wrong, is the default). */
export function fullTemplates(saved: unknown): MailTemplates {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Record<string, Partial<MailTemplate> | undefined>;
  return Object.fromEntries(MAIL_TEMPLATE_IDS.map((id) => {
    const d = MAIL_TEMPLATES[id], t = s[id];
    // saved before HTML existed (no html): the default design
    return [id, typeof t?.subject === 'string' && typeof t.body === 'string'
      ? { subject: t.subject, body: t.body, html: typeof t.html === 'string' ? t.html : d.html }
      : { subject: d.subject, body: d.body, html: d.html }];
  })) as MailTemplates;
}

/**
 * Checks templates from the admin page: { verify: { subject, body, html }, ... }; null for one puts it back to the
 * default; html "" sends plain text only (html left out: the default design). Errors are keyed "<id>.subject|body|html".
 */
export function checkTemplates(input: unknown): { ok: true; value: Partial<Record<MailTemplateId, MailTemplate | null>> } | { ok: false; errors: Record<string, string> } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: { templates: 'Send the templates to save.' } };
  const errors: Record<string, string> = {};
  const value: Partial<Record<MailTemplateId, MailTemplate | null>> = {};
  for (const [id, t] of Object.entries(input as Record<string, unknown>)) {
    if (!(id in MAIL_TEMPLATES)) { errors[id] = `There is no "${id}" email.`; continue; }
    const info = MAIL_TEMPLATES[id as MailTemplateId];
    if (t === null) { value[id as MailTemplateId] = null; continue; }
    const r = (t && typeof t === 'object' ? t : {}) as Record<string, unknown>;
    const subject = typeof r.subject === 'string' ? r.subject.replace(/\s+/g, ' ').trim() : '';
    const body = typeof r.body === 'string' ? r.body.replace(/\r\n?/g, '\n').trim() : '';
    const html = typeof r.html === 'string' ? r.html.replace(/\r\n?/g, '\n').trim() : info.html;
    const allowed = Object.keys(info.vars);
    const unknownVar = (text: string) => [...text.matchAll(VAR)].map((x) => x[1]!).find((n) => !allowed.includes(n));
    const list = allowed.map((n) => `{{${n}}}`).join(', ');
    if (!subject) errors[`${id}.subject`] = 'Enter a subject.';
    else if (subject.length > SUBJECT_MAX) errors[`${id}.subject`] = `Keep the subject to ${SUBJECT_MAX} characters.`;
    else if (unknownVar(subject)) errors[`${id}.subject`] = `{{${unknownVar(subject)}}} is not known here. Use ${list}.`;
    if (!body) errors[`${id}.body`] = 'Enter the email text.';
    else if (body.length > BODY_MAX) errors[`${id}.body`] = `Keep the email to ${BODY_MAX} characters.`;
    else if (unknownVar(body)) errors[`${id}.body`] = `{{${unknownVar(body)}}} is not known here. Use ${list}.`;
    else {
      const used = new Set([...`${subject}\n${body}`.matchAll(VAR)].map((x) => x[1]!));
      const missing = info.required.find((n) => !used.has(n));
      if (missing) errors[`${id}.body`] = `The email must include {{${missing}}}.`;
    }
    if (html.length > HTML_MAX) errors[`${id}.html`] = `Keep the HTML to ${HTML_MAX.toLocaleString('en-IN')} characters.`;
    else if (/<script\b/i.test(html)) errors[`${id}.html`] = 'Scripts do not work in email: remove the <script>.';
    else if (html && unknownVar(html)) errors[`${id}.html`] = `{{${unknownVar(html)}}} is not known here. Use ${list}.`;
    else if (html) {
      const used = new Set([...`${subject}\n${html}`.matchAll(VAR)].map((x) => x[1]!));
      const missing = info.required.find((n) => !used.has(n));
      if (missing) errors[`${id}.html`] = `The HTML must include {{${missing}}} too.`;
    }
    if (!errors[`${id}.subject`] && !errors[`${id}.body`] && !errors[`${id}.html`]) value[id as MailTemplateId] = { subject, body, html };
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value };
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Fills in {{names}}; a name without a value is left out. In the HTML, values are escaped and their line breaks kept. */
export function renderMail(t: MailTemplate, vars: Record<string, string>): { subject: string; text: string; html?: string } {
  const fill = (s: string) => s.replace(VAR, (_, n: string) => vars[n] ?? '');
  const fillHtml = (s: string) => s.replace(VAR, (_, n: string) => escapeHtml(vars[n] ?? '').replace(/\r?\n/g, '<br>'));
  return { subject: fill(t.subject).replace(/\s+/g, ' ').trim(), text: fill(t.body), ...(t.html ? { html: fillHtml(t.html) } : {}) };
}

/** What the admin page needs: each template now, its default, what it may use, and whether it was changed. */
export function templatesView(t: MailTemplates) {
  return {
    templates: MAIL_TEMPLATE_IDS.map((id) => {
      const d = MAIL_TEMPLATES[id];
      return { id, label: d.label, hint: d.hint, vars: d.vars, required: d.required, subject: t[id].subject, body: t[id].body, html: t[id].html,
        default: { subject: d.subject, body: d.body, html: d.html }, changed: t[id].subject !== d.subject || t[id].body !== d.body || t[id].html !== d.html };
    }),
  };
}
