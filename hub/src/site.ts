/**
 * A store's website design, made in the website builder (the ordering website's /admin page): theme, logo and SEO,
 * contact and social links, how the menu shows, an announcement bar, and the home page as a list of sections
 * (hero, featured dishes, menu, about, gallery, reviews, hours, contact, FAQ, text). The hub keeps a draft (what the
 * builder saves as the owner works) and the published copy (sent to customers with GET /v1/stores/<slug> as `site`).
 * Every saved document is checked here field by field; unknown fields are refused so a typo is never silently lost.
 * The menu, prices, item photos and opening hours still come from the POS.
 */

type Field =
  | { t: 'text'; max: number; multiline?: boolean }
  | { t: 'phone' } | { t: 'email' } | { t: 'url' } | { t: 'image' } | { t: 'color' } | { t: 'bool' }
  | { t: 'enum'; values: readonly string[] }
  | { t: 'int'; min: number; max: number }
  | { t: 'ids'; max: number }
  | { t: 'images'; max: number }
  | { t: 'list'; of: Spec; max: number };
type Spec = Record<string, Field>;

const text = (max: number, multiline = false): Field => ({ t: 'text', max, multiline });
const pick = (...values: string[]): Field => ({ t: 'enum', values });
const BOOL: Field = { t: 'bool' }, IMAGE: Field = { t: 'image' }, URL: Field = { t: 'url' }, COLOR: Field = { t: 'color' };

export const FONTS = ['Plus Jakarta Sans', 'Poppins', 'Inter', 'DM Sans', 'Nunito', 'Montserrat', 'Lora', 'Playfair Display'] as const;

const THEME: Spec = {
  primary: COLOR, accent: COLOR, text: COLOR, background: COLOR,
  font: pick(...FONTS), headingFont: pick(...FONTS),
  radius: pick('square', 'soft', 'rounded'), buttons: pick('square', 'rounded', 'pill'), header: pick('light', 'dark', 'brand'),
};
const BRAND: Spec = { name: text(60), tagline: text(80), logo: IMAGE, favicon: IMAGE, seoTitle: text(70), seoDescription: text(160), shareImage: IMAGE };
const CONTACT: Spec = {
  phone: { t: 'phone' }, whatsapp: { t: 'phone' }, email: { t: 'email' }, address: text(200), mapUrl: URL,
  instagram: URL, facebook: URL, youtube: URL, footerText: text(200),
};
const MENU: Spec = { layout: pick('grid', 'list'), showPhotos: BOOL, showDescriptions: BOOL, showVeg: BOOL, showCategoryChips: BOOL };
const BAR: Spec = { show: BOOL, text: text(200), link: URL };

/** Each section type and its own fields (besides id, type and hidden). */
export const SECTIONS: Record<string, Spec> = {
  hero: { title: text(80), subtitle: text(200), image: IMAGE, buttonText: text(30), align: pick('left', 'center') },
  featured: { title: text(60), itemIds: { t: 'ids', max: 12 } },
  menu: { title: text(60) },
  about: { title: text(60), text: text(1500, true), image: IMAGE },
  gallery: { title: text(60), images: { t: 'images', max: 12 } },
  reviews: { title: text(60), items: { t: 'list', max: 12, of: { name: text(40), text: text(300, true), rating: { t: 'int', min: 1, max: 5 } } } },
  hours: { title: text(60) },
  contact: { title: text(60), showMap: BOOL },
  faq: { title: text(60), items: { t: 'list', max: 20, of: { q: text(150), a: text(600, true) } } },
  text: { title: text(80), text: text(2000, true) },
};

export interface Section { id: string; type: string; hidden: boolean; [k: string]: unknown }
export interface SiteDoc {
  v: 1;
  theme: Record<string, string>; brand: Record<string, string>; contact: Record<string, string>;
  menu: Record<string, string | boolean>; bar: { show: boolean; text: string; link: string };
  sections: Section[];
}

const blank = (f: Field): unknown => f.t === 'bool' ? false : f.t === 'int' ? f.min : f.t === 'ids' || f.t === 'images' || f.t === 'list' ? [] : f.t === 'enum' ? f.values[0] : '';
const blankOf = (spec: Spec) => Object.fromEntries(Object.entries(spec).map(([k, f]) => [k, blank(f)]));

/** What a new section starts with in the builder. */
export function newSection(type: string, id: string): Section {
  const base = { id, type, hidden: false, ...blankOf(SECTIONS[type]!) } as Section;
  const titles: Record<string, string> = { featured: 'Our favourites', menu: 'Menu', about: 'About us', gallery: 'Gallery', reviews: 'What our customers say', hours: 'Opening hours', contact: 'Find us', faq: 'Questions', text: '' };
  if (type in titles) base.title = titles[type];
  if (type === 'hero') Object.assign(base, { title: 'Freshly cooked, delivered hot', subtitle: 'Made to order the moment the kitchen accepts. Delivery or pickup.', buttonText: 'Order now' });
  if (type === 'contact') base.showMap = true;
  return base;
}

/** The website as it looks before the owner changes anything (the same as the website's built-in design). */
export const DEFAULT_SITE: SiteDoc = {
  v: 1,
  theme: { primary: '#f5a85c', accent: '#e08733', text: '#17181a', background: '#ffffff', font: 'Plus Jakarta Sans', headingFont: 'Plus Jakarta Sans', radius: 'rounded', buttons: 'rounded', header: 'light' },
  brand: blankOf(BRAND) as Record<string, string>,
  contact: blankOf(CONTACT) as Record<string, string>,
  menu: { layout: 'grid', showPhotos: true, showDescriptions: true, showVeg: true, showCategoryChips: true },
  bar: { show: false, text: '', link: '' },
  sections: [newSection('hero', 'hero'), newSection('menu', 'menu')],
};

const HUB_IMAGE = /^hub:[0-9a-f]{64}\.(jpg|png|webp)$/;
const clean = (s: string) => s.replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

function checkField(f: Field, v: unknown, path: string, errors: Record<string, string>): unknown {
  const bad = (msg: string) => { errors[path] = msg; return undefined; };
  switch (f.t) {
    case 'bool': return typeof v === 'boolean' ? v : bad('Send true or false.');
    case 'int': return Number.isInteger(v) && (v as number) >= f.min && (v as number) <= f.max ? v : bad(`Send a whole number from ${f.min} to ${f.max}.`);
    case 'enum': return typeof v === 'string' && f.values.includes(v) ? v : bad(`Choose one of: ${f.values.join(', ')}.`);
    case 'ids':
      if (!Array.isArray(v) || v.length > f.max || v.some((x) => typeof x !== 'string' || !x || x.length > 64)) return bad(`Pick up to ${f.max} dishes.`);
      return [...new Set(v as string[])];
    case 'images': {
      if (!Array.isArray(v) || v.length > f.max) return bad(`Add up to ${f.max} photos.`);
      const out = v.map((x, i) => checkField(IMAGE, x, `${path}.${i}`, errors));
      return out.filter(Boolean);
    }
    case 'list':
      if (!Array.isArray(v) || v.length > f.max) return bad(`Add up to ${f.max}.`);
      return v.map((x, i) => checkSpec(f.of, x, `${path}.${i}`, errors));
    default: break;
  }
  if (typeof v !== 'string') return bad('Send text.');
  const s = f.t === 'text' && f.multiline ? clean(v) : v.replace(/\s+/g, ' ').trim();
  if (!s) return '';
  switch (f.t) {
    case 'text': return s.length <= f.max ? s : bad(`Keep it under ${f.max} characters.`);
    case 'phone': return /^\+?[0-9][0-9 -]{5,18}[0-9]$/.test(s) ? s : bad('Enter a phone number with digits, spaces or dashes, e.g. +91 98765 43210.');
    case 'email': return s.length <= 100 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : bad('Enter an email address.');
    case 'url': return s.length <= 500 && /^https:\/\/[^\s/]+\.[^\s/]+(\/\S*)?$/.test(s) ? s : bad('Enter an https:// link.');
    case 'image': return HUB_IMAGE.test(s) || (s.length <= 500 && /^https:\/\/[^\s/]+\.[^\s/]+\/\S+$/.test(s)) ? s : bad('Upload a photo, or use an https:// image link.');
    case 'color': return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toLowerCase() : bad('The colour must look like #ea580c.');
  }
}

/** Missing fields get their blank value (so older documents keep working); unknown ones are errors. */
function checkSpec(spec: Spec, v: unknown, path: string, errors: Record<string, string>, ignore: string[] = []): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) { errors[path] = 'Send an object.'; return {}; }
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v)) if (!(k in spec) && !ignore.includes(k)) errors[`${path}.${k}`] = 'Unknown setting.';
  for (const [k, f] of Object.entries(spec)) {
    const x = (v as Record<string, unknown>)[k];
    out[k] = x === undefined ? blank(f) : checkField(f, x, `${path}.${k}`, errors);
  }
  return out;
}

export function checkSite(input: unknown): { ok: true; value: SiteDoc } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: { site: 'Send the website design.' } };
  const d = input as Record<string, unknown>;
  for (const k of Object.keys(d)) if (!['v', 'theme', 'brand', 'contact', 'menu', 'bar', 'sections'].includes(k)) errors[k] = 'Unknown setting.';
  if (d.v !== 1) errors.v = 'Unknown design version.';
  const part = (k: string, spec: Spec, def: Record<string, unknown>) => d[k] === undefined ? { ...def } : checkSpec(spec, d[k], k, errors);
  const site = {
    v: 1 as const,
    theme: part('theme', THEME, DEFAULT_SITE.theme), brand: part('brand', BRAND, DEFAULT_SITE.brand), contact: part('contact', CONTACT, DEFAULT_SITE.contact),
    menu: part('menu', MENU, DEFAULT_SITE.menu), bar: part('bar', BAR, DEFAULT_SITE.bar), sections: [] as Section[],
  };
  if (!Array.isArray(d.sections) || d.sections.length > 20) errors.sections = 'Send up to 20 sections.';
  else {
    const ids = new Set<string>();
    d.sections.forEach((s, i) => {
      const p = `sections.${i}`;
      const t = (s as { type?: unknown } | null)?.type, id = (s as { id?: unknown } | null)?.id;
      if (typeof t !== 'string' || !(t in SECTIONS)) { errors[`${p}.type`] = 'Unknown section type.'; return; }
      if (typeof id !== 'string' || !/^[a-z0-9-]{1,24}$/.test(id) || ids.has(id)) { errors[`${p}.id`] = 'Each section needs its own short id.'; return; }
      ids.add(id);
      const hidden = (s as { hidden?: unknown }).hidden ?? false;
      if (typeof hidden !== 'boolean') errors[`${p}.hidden`] = 'Send true or false.';
      site.sections.push({ id, type: t, hidden: hidden === true, ...checkSpec(SECTIONS[t]!, s, p, errors, ['id', 'type', 'hidden']) });
    });
    if (site.sections.filter((s) => s.type === 'menu').length !== 1 && !Object.keys(errors).some((k) => k.startsWith('sections'))) errors.sections = 'The page needs exactly one menu section (customers order from it).';
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: site as unknown as SiteDoc };
}

/** A saved document read back. A broken or outdated one falls back to the default design rather than breaking the website. */
export function readSite(json: string | null): SiteDoc {
  if (!json) return structuredClone(DEFAULT_SITE);
  try {
    const raw = JSON.parse(json);
    if (raw && raw.v === undefined) return fromFlat(raw); // the first website settings (title, phone, ...), before the builder
    const c = checkSite(raw);
    return c.ok ? c.value : structuredClone(DEFAULT_SITE);
  } catch { return structuredClone(DEFAULT_SITE); }
}

/** The short-lived flat website settings (hub admin page, before the builder) as a design. */
function fromFlat(w: Record<string, unknown>): SiteDoc {
  const s = (k: string) => (typeof w[k] === 'string' ? w[k] as string : '');
  const site = structuredClone(DEFAULT_SITE);
  const hero = site.sections[0]!;
  if (s('heroTitle')) hero.title = s('heroTitle');
  if (s('heroSubtitle')) hero.subtitle = s('heroSubtitle');
  if (s('heroImage')) hero.image = s('heroImage');
  Object.assign(site.contact, { phone: s('phone'), address: s('address'), footerText: s('about') });
  if (s('announcement')) site.bar = { show: true, text: s('announcement'), link: '' };
  if (/^#[0-9a-f]{6}$/.test(s('brandColor'))) site.theme.primary = s('brandColor');
  const c = checkSite(site);
  return c.ok ? c.value : structuredClone(DEFAULT_SITE);
}

/** The photos a design uses (hub:<name> references), so the builder can show what is uploaded. */
export function siteImages(site: SiteDoc): string[] {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === 'string') { if (HUB_IMAGE.test(v)) out.add(v.slice(4)); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(site);
  return [...out];
}
