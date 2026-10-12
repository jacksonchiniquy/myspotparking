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
  const startedAt = new Date();
  const updated = await sb('PATCH', `parking_sessions?id=eq.${row.id}&status=eq.pending`, {
    status: 'active',
    started_at: startedAt.toISOString(),
    expires_at: new Date(startedAt.getTime() + minutes * 60000).toISOString(),
    amount_paid: (checkout.amount_total ?? Math.round(Number(row.amount_paid || 0) * 100)) / 100,
  });
  if (updated && updated[0]) {
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

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = iso => new Date(iso).toLocaleString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
const fmtDuration = m => m >= 480 ? 'Full Day' : m >= 60 ? `${m / 60} Hour${m > 60 ? 's' : ''}` : `${m} Min`;

async function sendReceipt(row, to) {
  const [property] = await sb('GET', `properties?id=eq.${row.property_id}&select=name,address`);
  const name = property?.name || 'Parking';
  const amount = `$${Number(row.amount_paid || 0).toFixed(2)}`;
  const rows = [
    ['Plate', row.plate], ['Vehicle', row.vehicle_desc || '—'], ['Location', name + (property?.address ? ` — ${property.address}` : '')],
    ['Duration', fmtDuration(Number(row.duration_minutes) || 0)], ['Started', fmtTime(row.started_at)],
    ['Expires', fmtTime(row.expires_at)], ['Amount Paid', amount],
  ];
  const table = rows.map(([k, v]) => `<tr><td style="padding:6px 0;color:#64748b;font-size:13px;">${k}</td><td style="padding:6px 0;text-align:right;font-weight:700;font-size:14px;">${esc(v)}</td></tr>`).join('');
  await sendRaw({
    to,
    subject: `Parking receipt — ${row.plate} at ${name}`,
    html: `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 16px;color:#0f172a;background:#ffffff;">
  ${logoHeader('#059669')}
  <h2 style="margin:0 0 8px;">You're all set!</h2>
  <p style="color:#475569;margin:0 0 20px;">Your parking session is active. Show this email if an enforcement officer checks your vehicle.</p>
  <div style="background:#f4f7ff;border-radius:10px;padding:16px 20px;margin-bottom:20px;"><table width="100%" cellpadding="0" cellspacing="0">${table}</table></div>
  <p style="color:#94a3b8;font-size:12px;">Keep this email as your receipt.</p>
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;">
  <p style="color:#94a3b8;font-size:11px;text-align:center;">© ${new Date().getFullYear()} My Spot Parking Inc. · Provo, UT</p>
</body></html>`,
    text: `Parking receipt\n\n` + rows.map(([k, v]) => `${k}: ${v}`).join('\n') + `\n\nShow this email if an enforcement officer checks your vehicle.`,
  });
}

module.exports = { DEFAULT_RATES, ratesFor, sb, activateSession };
