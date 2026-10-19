// Shared guest pass rules: time windows, allowance periods, codes, emails.
// Used by unit-api.js (residents give passes), guest-pass.js (guests activate)
// and guest-reminders.js (reminder emails).

const crypto = require('crypto');

const TZ = 'America/Denver';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O, 1/I
const CODE_RE = /^G-?([A-Z2-9]{4})-?([A-Z2-9]{2})$/;

// ── Time in Mountain Time ───────────────────────────────────
function localParts(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date).filter(x => x.type !== 'literal').map(x => [x.type, Number(x.value)]));
  if (p.hour === 24) p.hour = 0;
  return p;
}
// The moment that is y-m-d hh:mm in Mountain Time (handles daylight saving)
function zoned(y, m, d, hh = 0, mm = 0) {
  let guess = Date.UTC(y, m - 1, d, hh, mm);
  for (let i = 0; i < 3; i++) {
    const p = localParts(new Date(guess));
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const want = Date.UTC(y, m - 1, d, hh, mm);
    if (asUtc === want) break;
    guess += want - asUtc;
  }
  return new Date(guess);
}
function addDays(y, m, d, n) { const t = new Date(Date.UTC(y, m - 1, d + n)); return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()]; }
const hm = t => { const [h, m] = String(t || '0:0').split(':').map(Number); return [h || 0, m || 0]; };

// When a pass of this type is valid if it starts being used at `now`
function passWindow(type, now = new Date()) {
  if (type.length_kind === 'hours') {
    const hours = Math.max(1, Number(type.hours) || 12);
    return { starts: now, ends: new Date(now.getTime() + hours * 3600e3) };
  }
  if (type.length_kind === 'window') {
    const [sh, sm] = hm(type.window_start), [eh, em] = hm(type.window_end);
    const wraps = eh * 60 + em <= sh * 60 + sm;                 // e.g. 6 PM → 10 AM next day
    const t = localParts(now);
    const windowFor = (y, m, d) => {
      const starts = zoned(y, m, d, sh, sm);
      const [ey, emo, ed] = wraps ? addDays(y, m, d, 1) : [y, m, d];
      return { starts, ends: zoned(ey, emo, ed, eh, em) };
    };
    const [py, pm, pd] = addDays(t.year, t.month, t.day, -1);
    const yesterday = windowFor(py, pm, pd), today = windowFor(t.year, t.month, t.day);
    const [ny, nm, nd] = addDays(t.year, t.month, t.day, 1);
    const SHORT = 2 * 3600e3; // less than 2 hours left in a window: use the next one instead
    const cur = (now >= yesterday.starts && now < yesterday.ends) ? yesterday
      : (now >= today.starts && now < today.ends) ? today : null;
    if (cur) {
      if (cur.ends - now >= SHORT) return { starts: now, ends: cur.ends };
      return cur === yesterday ? today : windowFor(ny, nm, nd);
    }
    if (now < today.starts) return today;                       // starts later today
    return windowFor(ny, nm, nd);
  }
  return null; // 'dates' passes are picked by the resident (manager approval)
}

// Start of the current allowance period and when it refills
function allowancePeriod(reset, now = new Date()) {
  const t = localParts(now);
  const months = { monthly: 1, quarterly: 3, semiannual: 6, yearly: 12 }[reset] || 12;
  const startMonth = Math.floor((t.month - 1) / months) * months + 1;
  const start = zoned(t.year, startMonth, 1);
  let ny = t.year, nm = startMonth + months;
  if (nm > 12) { nm -= 12; ny += 1; }
  const next = zoned(ny, nm, 1);
  return { start, next };
}
function monthStart(now = new Date()) { const t = localParts(now); return zoned(t.year, t.month, 1); }

function describeType(type) {
  if (type.length_kind === 'hours') return `${type.hours} hour${Number(type.hours) === 1 ? '' : 's'}`;
  if (type.length_kind === 'window') return `${fmtClock(type.window_start)} – ${fmtClock(type.window_end)}`;
  return `Up to ${type.max_days} days`;
}
function fmtClock(t) { const [h, m] = hm(t); return `${(h % 12) || 12}${m ? ':' + String(m).padStart(2, '0') : ''} ${h < 12 ? 'AM' : 'PM'}`; }
const fmtWhen = d => new Date(d).toLocaleString('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const fmtDay = d => new Date(d).toLocaleDateString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric' });

function newCode() {
  const pick = n => Array.from(crypto.randomBytes(n), b => CODE_CHARS[b % CODE_CHARS.length]).join('');
  // The last two always include a letter, so a guest code can never look like a property code (ABC-1234)
  let tail = pick(2);
  while (!/[A-Z]/.test(tail)) tail = pick(2);
  return `G-${pick(4)}-${tail}`;
}
function normalizeCode(raw) {
  const m = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').match(/^G([A-Z2-9]{4})([A-Z2-9]{2})$/);
  return m ? `G-${m[1]}-${m[2]}` : null;
}
const normPlate = p => String(p || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);

// A pass still "uses up" one of the unit's passes unless it was cancelled
// or its code expired without being used.
function countsAgainstAllowance(g, now = new Date()) {
  if (g.status === 'cancelled' || g.status === 'expired') return false;
  if (g.status === 'issued' && g.code_expires_at && new Date(g.code_expires_at) <= now) return false;
  return true;
}

// The guest's "here's your pass" email
function passEmail(g, { propertyName, unitLabel, typeName, logoHeader }) {
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rows = [['Plate', `${g.guest_state ? g.guest_state + ' · ' : ''}${g.guest_plate}`], ['Vehicle', g.guest_vehicle || '—'],
    ['Property', propertyName], ['Guest of', unitLabel], ['Pass', typeName], ['Starts', fmtWhen(g.starts_at)], ['Valid until', fmtWhen(g.ends_at)]];
  const table = rows.map(([k, v]) => `<tr><td style="padding:6px 0;color:#64748b;font-size:13px;">${k}</td><td style="padding:6px 0;text-align:right;font-weight:700;font-size:14px;">${esc(v)}</td></tr>`).join('');
  return {
    subject: `Your guest parking pass — ${propertyName}`,
    html: `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 16px;color:#0f172a;background:#ffffff;">
  ${logoHeader('#15803d')}
  <h2 style="margin:0 0 8px;">Your guest pass is active</h2>
  <p style="color:#475569;margin:0 0 20px;">Show this email if an enforcement officer checks your vehicle. We'll remind you about an hour before it ends.</p>
  <div style="background:#f0fdf4;border-radius:10px;padding:16px 20px;margin-bottom:20px;"><table width="100%" cellpadding="0" cellspacing="0">${table}</table></div>
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;">
  <p style="color:#94a3b8;font-size:11px;text-align:center;">© ${new Date().getFullYear()} My Spot Parking Inc. · Provo, UT</p>
</body></html>`,
    text: 'Your guest pass is active\n\n' + rows.map(([k, v]) => `${k}: ${v}`).join('\n') + '\n\nShow this email if an enforcement officer checks your vehicle.',
  };
}

module.exports = {
  TZ, CODE_RE, passWindow, allowancePeriod, monthStart, describeType, fmtClock, fmtWhen, fmtDay,
  newCode, normalizeCode, normPlate, countsAgainstAllowance, passEmail, localParts, zoned,
};
