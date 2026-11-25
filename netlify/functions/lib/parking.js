// Shared Pay to Park helpers (create-parking-session, parking-session-status, stripe-webhook)

const { sendRaw, logoHeader } = require('../send-email');

const SUPABASE_URL = process.env.SUPABASE_URL;
const TZ = 'America/Denver';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Same defaults pay.html and the manager portal show when a property has no rates saved
const DEFAULT_RATES = [
  { id: '1h',  name: '1 Hour',   minutes: 60,  amount: 300,  desc: 'Short stay' },
  { id: '2h',  name: '2 Hours',  minutes: 120, amount: 500,  desc: 'Most popular' },
  { id: '4h',  name: '4 Hours',  minutes: 240, amount: 800,  desc: 'Half day' },
  { id: 'day', name: 'Full Day', minutes: 480, amount: 1200, desc: 'All day parking' },
];

function ratesFor(property) {
  const r = property && property.transient_rates;
  return Array.isArray(r) && r.length ? r : DEFAULT_RATES;
}

// ── Parking areas ("Where are you parked?") ──
// properties.area_mode: 'off' | 'optional' | 'required'
// properties.parking_areas: [{ id, name, desc }]
function areasFor(property) {
  const a = property && property.parking_areas;
  return Array.isArray(a) ? a.filter(x => x && x.id && String(x.name || '').trim()) : [];
}
function areaModeFor(property) {
  const m = (property && property.area_mode) || 'off';
  return areasFor(property).length ? m : 'off'; // no areas set up yet: don't ask
}
// The area a driver picked (by id, or by name from an older link), or null
function findArea(property, raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return null;
  return areasFor(property).find(a => String(a.id).toLowerCase() === v || String(a.name).trim().toLowerCase() === v) || null;
}
// Does this rate show in this area? A rate with no areas shows everywhere.
function rateInArea(rate, area) {
  const ids = Array.isArray(rate && rate.areas) ? rate.areas : [];
  if (!ids.length) return true;
  return !!area && ids.includes(area.id);
}
// The rates a driver can pick. No area chosen: only the rates for every area
// (or every rate, if all of them are limited to areas).
// Longest stay (minutes) or null; and whether rates longer than it are hidden
function maxStayFor(property) {
  const m = Math.round(Number(property && property.max_stay_minutes));
  return m >= 15 ? m : null;
}
function fitsMax(property, r) {
  const max = maxStayFor(property);
  return !(max && property.hide_long_rates && Number(r.minutes) > max);
}
function ratesForArea(property, area) {
  const all = ratesFor(property).filter(r => fitsMax(property, r));
  if (areaModeFor(property) === 'off') return all;
  if (area) return all.filter(r => rateInArea(r, area));
  const open = all.filter(r => !(Array.isArray(r.areas) && r.areas.length));
  return open.length ? open : all;
}

async function sb(method, path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
      ...(method === 'GET' ? {} : { Prefer: 'return=representation' }),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${method} ${path.split('?')[0]} ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

// Turn a paid Stripe checkout into an active parking session (safe to call twice).
// The parking clock starts when payment is confirmed, not when checkout began.
async function activateSession(checkout) {
  if (!checkout || checkout.payment_status !== 'paid') return null;
  const rows = await sb('GET', `parking_sessions?stripe_session_id=eq.${encodeURIComponent(checkout.id)}&select=*`);
  const row = rows[0];
  if (!row) return null;
  if (row.status === 'active' || row.status === 'expired') return row;
  const minutes = Number(row.duration_minutes) || 60;
  // Added time starts when the driver's current session ends (or now, if it already has)
  let startedAt = new Date();
  if (row.extends_id) {
    try {
      const cur = await latestActive(row.property_id, row.plate, row.id);
      if (cur && new Date(cur.expires_at) > startedAt) startedAt = new Date(cur.expires_at);
    } catch (e) { console.error('Add time start lookup failed:', e.message); }
  }
  const updated = await sb('PATCH', `parking_sessions?id=eq.${row.id}&status=eq.pending`, {
    status: 'active',
    started_at: startedAt.toISOString(),
    expires_at: new Date(startedAt.getTime() + minutes * 60000).toISOString(),
    amount_paid: checkout.amount_total ?? row.amount_paid, // cents
  });
  if (updated && updated[0]) {
    // Paid with a promo code: count the use
    if (updated[0].promo_code) {
      try {
        const P = require('./promo');
        const pr = await P.findPromo(updated[0].property_id, updated[0].promo_code);
        if (pr) await P.useIt(pr.id);
      } catch (e) { console.error('Counting promo use failed:', e.message); }
    }
    // First (and only) activation: send the driver a receipt
    const to = updated[0].email || checkout.customer_details?.email;
    if (to) {
      try { await sendReceipt(updated[0], to); }
      catch (e) { console.error('Pay to Park receipt email failed:', e); }
    }
    return updated[0];
  }
  // Someone else activated it at the same moment; return the current row
  return (await sb('GET', `parking_sessions?id=eq.${row.id}&select=*`))[0];
}

const SITE = process.env.SITE_URL || 'https://lothq.com';
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const I = require('./i18n');
const fmtTime = (iso, lang, tz = TZ) => new Date(iso).toLocaleString(I.locale(lang), { timeZone: tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
// "Full Day", "2 Hours", "30 Min" in the person's language
function fmtDuration(m, lang) {
  if (m >= 480) return I.t(lang, 'Full Day');
  if (m === 60) return I.t(lang, '1 Hour');
  if (m >= 60) return I.t(lang, m > 60 ? '{n} Hours' : '{n} Hour', { n: m / 60 });
  return I.t(lang, '{n} Min', { n: m });
}
// ── Add time ──
// The driver's latest active session for this plate at this property (skipping one id)
async function latestActive(propertyId, plate, skipId) {
  const now = new Date().toISOString();
  const rows = await sb('GET', `parking_sessions?property_id=eq.${propertyId}&plate=eq.${encodeURIComponent(plate)}&status=eq.active&expires_at=gt.${now}${skipId ? `&id=neq.${skipId}` : ''}&select=*&order=expires_at.desc&limit=1`);
  return rows[0] || null;
}
// The session a driver is adding time to: { property, latest } or { error }
async function extendTarget(id) {
  const [orig] = await sb('GET', `parking_sessions?id=eq.${id}&select=*`);
  if (!orig || orig.status === 'pending') return { error: 'That parking session wasn\'t found.' };
  const [property] = await sb('GET', `properties?id=eq.${orig.property_id}&select=*`);
  if (!property) return { error: 'That parking session wasn\'t found.' };
  if (!property.add_time_enabled) return { error: 'Adding time isn\'t offered at this property. Please start a new session.', ended: true };
  if (!require('./features').on(property, 'pay_to_park')) return { error: 'Pay to Park isn\'t offered at this property.', ended: true };
  const latest = await latestActive(property.id, orig.plate);
  if (!latest) return { error: 'This parking session has ended. Please start a new one.', ended: true };
  const stay = stayInfo(property, latest);
  if (stay.reached) return { error: `You've reached the longest stay allowed here (${fmtLimit(stay.max)}). Please move your vehicle when your time ends.`, ended: true, reached: true };
  return { property, latest, stay };
}
// When this car's stay began, and how much of the property's longest stay is left
function stayStart(row) { return new Date(row.stay_started_at || row.started_at); }
function stayInfo(property, latest) {
  const max = maxStayFor(property);
  if (!max || !latest) return { max: null, used: null, left: null, reached: false };
  const used = Math.round((new Date(latest.expires_at) - stayStart(latest)) / 60000);
  const left = max - used;
  return { max, used, left, reached: left < 15 };
}
// Can this driver still add time? (Add time on, and not at the longest stay)
function canAddTime(property, row) {
  if (!property || !property.add_time_enabled) return false;
  return !stayInfo(property, row).reached;
}
// "8 hours", "90 minutes"
function fmtLimit(m) { return m % 60 === 0 ? `${m / 60} hour${m === 60 ? '' : 's'}` : `${m} minutes`; }

// Save a new session; before the languages database step, without its language
async function insertSession(row) {
  try { return await sb('POST', 'parking_sessions', row); }
  catch (e) {
    // Before the longest stay database step: save without when the stay began
    if (row.stay_started_at !== undefined && /stay_started_at/.test(e.message)) { const { stay_started_at, ...rest } = row; return insertSession(rest); }
    // Before the parking areas database step: save without the area
    if (row.area !== undefined && /\barea\b/.test(e.message)) { const { area, ...rest } = row; return insertSession(rest); }
    if (row.lang !== undefined && /lang/.test(e.message)) { const { lang, ...rest } = row; return sb('POST', 'parking_sessions', rest); }
    throw e;
  }
}

async function sendReceipt(row, to) {
  const lang = I.pick(row.lang);
  const t = (en, v) => I.t(lang, en, v);
  const [property] = await sb('GET', `properties?id=eq.${row.property_id}&select=*`);
  const name = property?.name || 'Parking';
  const tz = (property && property.timezone) || TZ;
  const amount = `$${(Number(row.amount_paid || 0) / 100).toFixed(2)}`;
  const rows = [
    [t('Plate'), row.plate], [t('Vehicle'), row.vehicle_desc || '—'], [t('Location'), name + (property?.address ? ` — ${property.address}` : '')],
    ...(row.area ? [[t('Area'), row.area]] : []),
    ...(row.stall ? [[t('Stall'), row.stall]] : []),
    [t('Duration'), fmtDuration(Number(row.duration_minutes) || 0, lang)], [t('Started'), fmtTime(row.started_at, lang, tz)],
    [t('Expires'), fmtTime(row.expires_at, lang, tz)],
    ...(row.promo_code ? [[t('Promo code'), row.original_cents ? t('{code} (was {amt})', { code: row.promo_code, amt: `$${(Number(row.original_cents) / 100).toFixed(2)}` }) : row.promo_code]] : []),
    [t('Amount Paid'), Number(row.amount_paid) > 0 ? amount : t('Free')],
  ];
  const table = rows.map(([k, v]) => `<tr><td style="padding:6px 0;color:#64748b;font-size:13px;">${k}</td><td style="padding:6px 0;text-align:right;font-weight:700;font-size:14px;">${esc(v)}</td></tr>`).join('');
  await sendRaw({
    to,
    subject: t('Parking receipt — {plate} at {property}', { plate: row.plate, property: name }),
    html: `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 16px;color:#0f172a;background:#ffffff;">
  ${logoHeader('#059669')}
  <h2 style="margin:0 0 8px;">${esc(t("You're all set!"))}</h2>
  <p style="color:#475569;margin:0 0 20px;">${esc(t('Your parking session is active. Show this email if an enforcement officer checks your vehicle.'))}</p>
  <div style="background:#f4f7ff;border-radius:10px;padding:16px 20px;margin-bottom:20px;"><table width="100%" cellpadding="0" cellspacing="0">${table}</table></div>
  ${canAddTime(property, row) ? `<p style="margin:0 0 20px;"><a href="${SITE}/pay.html?extend=${row.id}" style="display:inline-block;background:#1a6fff;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:8px;">${esc(t('Add time'))}</a></p>` : ''}
  <p style="color:#94a3b8;font-size:12px;">${esc(t('Keep this email as your receipt.'))}</p>
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;">
  <p style="color:#94a3b8;font-size:11px;text-align:center;">© ${new Date().getFullYear()} LotHQ · Provo, UT</p>
</body></html>`,
    text: t('Parking receipt — {plate} at {property}', { plate: row.plate, property: name }) + `\n\n` + rows.map(([k, v]) => `${k}: ${v}`).join('\n') + `\n\n` + t('Show this email if an enforcement officer checks your vehicle.'),
  });
}

module.exports = { maxStayFor, fitsMax, stayInfo, canAddTime, fmtLimit, latestActive, extendTarget, SITE, fmtTime, esc, DEFAULT_RATES, ratesFor, areasFor, areaModeFor, findArea, rateInArea, ratesForArea, sb, activateSession, sendReceipt, insertSession, fmtDuration };
