// i18n.js — the language pack for a page (used by /lang.js)
//   GET ?want=es,en-US,fr   → the first wanted language that's switched on,
//                             its translations, and the menu of languages
//   GET ?want=es&all=1      → (admins previewing) any language, even if switched off
const I = require('./lib/i18n');

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  const on = await I.enabled();
  const wants = String(q.want || '').split(',').map(s => s.trim().toLowerCase().split('-')[0]).filter(Boolean);
  const allowed = q.all === '1' ? Object.keys(I.LANGS) : on;
  const lang = wants.find(c => allowed.includes(c)) || 'en';
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
    body: JSON.stringify({
      lang, locale: I.locale(lang),
      languages: on.map(c => ({ code: c, name: I.LANGS[c].name })),
      dict: I.dict(lang),
    }),
  };
};
