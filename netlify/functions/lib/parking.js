// Shared Pay to Park helpers (create-parking-session, parking-session-status, stripe-webhook)

const SUPABASE_URL = process.env.SUPABASE_URL;
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
  if (updated && updated[0]) return updated[0];
  // Someone else activated it at the same moment; return the current row
  return (await sb('GET', `parking_sessions?id=eq.${row.id}&select=*`))[0];
}

module.exports = { DEFAULT_RATES, ratesFor, sb, activateSession };
