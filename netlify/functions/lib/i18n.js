// Languages for the pages residents, guests and drivers use, and their emails.
//
// Translations are keyed by the English text itself (lib/i18n/<code>.json), so
// English needs no file and anything not translated simply stays in English.
// "{name}" in a key is a fill-in: t('es', 'Sent to {email}.', { email }) .
//
// Which languages people can pick is set by LotHQ admins (site_settings
// key "languages"); English is always on.

const LANGS = {
  en: { name: 'English', locale: 'en-US' },
  es: { name: 'Español', locale: 'es-US' },
  zh: { name: '中文 (简体)', locale: 'zh-CN' },
  vi: { name: 'Tiếng Việt', locale: 'vi-VN' },
  tl: { name: 'Tagalog', locale: 'fil-PH' },
  pt: { name: 'Português', locale: 'pt-BR' },
  fr: { name: 'Français', locale: 'fr-FR' },
  ko: { name: '한국어', locale: 'ko-KR' },
};
const DEFAULT_ON = ['en', 'es'];

// Spelled out one by one so the site's bundler includes every file
const FILES = {
  es: () => require('./i18n/es.json'), zh: () => require('./i18n/zh.json'), vi: () => require('./i18n/vi.json'),
  tl: () => require('./i18n/tl.json'), pt: () => require('./i18n/pt.json'), fr: () => require('./i18n/fr.json'),
  ko: () => require('./i18n/ko.json'),
};
const cache = {};
function dict(code) {
  if (!FILES[code]) return {};
  if (!cache[code]) {
    try { cache[code] = FILES[code](); } catch { cache[code] = {}; }
  }
  return cache[code];
}

const pick = code => (LANGS[String(code || '').toLowerCase()] ? String(code).toLowerCase() : 'en');
const locale = code => LANGS[pick(code)].locale;

function fill(s, vars) {
  return vars ? String(s).replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m)) : String(s);
}
// Translate English text into `code` (falls back to the English)
function t(code, en, vars) {
  const d = dict(pick(code));
  return fill(d[en] || en, vars);
}

// Enabled languages (admins switch them on). Never throws.
let enabledCache = null, enabledAt = 0;
async function enabled() {
  if (enabledCache && Date.now() - enabledAt < 60e3) return enabledCache;
  let list = DEFAULT_ON;
  try {
    const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/site_settings?key=eq.languages&select=value`, {
      headers: { apikey: process.env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}` },
    });
    if (res.ok) {
      const [row] = await res.json();
      if (row && Array.isArray(row.value)) list = ['en', ...row.value.filter(c => LANGS[c] && c !== 'en')];
    }
  } catch { /* keep default */ }
  enabledCache = list; enabledAt = Date.now();
  return list;
}

// Dates and times in the person's language
function fmt(code, d, opts) {
  return new Date(d).toLocaleString(locale(code), opts);
}

// Stripe's own checkout page in the same language
const STRIPE = { es: 'es', zh: 'zh', vi: 'vi', tl: 'fil', pt: 'pt-BR', fr: 'fr', ko: 'ko' };
const stripeLocale = code => STRIPE[pick(code)] || 'auto';

module.exports = { stripeLocale, LANGS, DEFAULT_ON, dict, pick, locale, t, fill, enabled, fmt };
