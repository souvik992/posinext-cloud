/**
 * The emails the hub sends to customers, editable on the admin page (Hub settings > Email templates) and saved as the
 * setting "mailTemplates" (only the ones changed from the default). Plain text; {{name}} is replaced when sent.
 */

export interface MailTemplate { subject: string; body: string }

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
  },
  reset: {
    label: 'Password reset code',
    hint: 'Sent when someone presses "Forgot password" on the portal.',
    vars: { code: '482913', minutes: '10' },
    required: ['code'],
    subject: 'Reset your PosiNext password',
    body: 'Your PosiNext password reset code is {{code}}.\n\nIt works for {{minutes}} minutes. If you did not ask to reset your password, ignore this email: your password stays the same.',
  },
  ticketReply: {
    label: 'Support ticket answer',
    hint: 'Sent to the customer who opened a ticket when you answer it (Support).',
    vars: { reply: 'Thanks for writing in. The printer setting is under Settings > Printers.', staffName: 'Support team', ticketNumber: '42', ticketSubject: 'Printer not printing KOTs' },
    required: ['reply'],
    subject: 'Re: [Ticket #{{ticketNumber}}] {{ticketSubject}}',
    body: '{{reply}}\n\n— {{staffName}}\n\nSee the whole conversation and reply in your client area: Support tickets › #{{ticketNumber}}.',
  },
} satisfies Record<string, TemplateInfo>;

export type MailTemplateId = keyof typeof MAIL_TEMPLATES;
export type MailTemplates = Record<MailTemplateId, MailTemplate>;
export const MAIL_TEMPLATE_IDS = Object.keys(MAIL_TEMPLATES) as MailTemplateId[];

const VAR = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
const SUBJECT_MAX = 200, BODY_MAX = 5000;

/** The saved templates over the defaults (one not saved, or saved wrong, is the default). */
export function fullTemplates(saved: unknown): MailTemplates {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Record<string, Partial<MailTemplate> | undefined>;
  return Object.fromEntries(MAIL_TEMPLATE_IDS.map((id) => {
    const d = MAIL_TEMPLATES[id], t = s[id];
    return [id, typeof t?.subject === 'string' && typeof t.body === 'string' ? { subject: t.subject, body: t.body } : { subject: d.subject, body: d.body }];
  })) as MailTemplates;
}

/**
 * Checks templates from the admin page: { verify: { subject, body }, ... }; null for one puts it back to the default.
 * Errors are keyed "<id>.subject" / "<id>.body".
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
    if (!errors[`${id}.subject`] && !errors[`${id}.body`]) value[id as MailTemplateId] = { subject, body };
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value };
}

/** Fills in {{names}}; a name without a value is left out. */
export function renderMail(t: MailTemplate, vars: Record<string, string>): { subject: string; text: string } {
  const fill = (s: string) => s.replace(VAR, (_, n: string) => vars[n] ?? '');
  return { subject: fill(t.subject).replace(/\s+/g, ' ').trim(), text: fill(t.body) };
}

/** What the admin page needs: each template now, its default, what it may use, and whether it was changed. */
export function templatesView(t: MailTemplates) {
  return {
    templates: MAIL_TEMPLATE_IDS.map((id) => {
      const d = MAIL_TEMPLATES[id];
      return { id, label: d.label, hint: d.hint, vars: d.vars, required: d.required, subject: t[id].subject, body: t[id].body,
        default: { subject: d.subject, body: d.body }, changed: t[id].subject !== d.subject || t[id].body !== d.body };
    }),
  };
}
