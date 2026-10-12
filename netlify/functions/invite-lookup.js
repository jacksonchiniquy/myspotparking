// invite-lookup.js — used by signup.html to look up an invite code.
// Returns only what the sign-up page needs (never passwords, emails or other units).

const { unitSpots, publicSpot } = require('./lib/spot-pricing');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

function reply(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed' });
  let code;
  try { code = String(JSON.parse(event.body || '{}').code || '').trim().toUpperCase(); } catch { return reply(400, { error: 'Invalid request' }); }
  if (!/^[A-Z0-9-]{4,20}$/.test(code)) return reply(200, { unit: null });

  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/property_units?invite_code=eq.${encodeURIComponent(code)}&select=*,properties(*)&limit=1`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
    );
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
    const [u] = await res.json();
    if (!u) return reply(200, { unit: null });
    const p = u.properties || {};
    // Every spot in this unit, with its price, so the resident can pick paid ones
    const spots = u.invite_used ? [] : (await unitSpots(u)).map(s => publicSpot(s, p));
    return reply(200, {
      unit: {
        invite_code: u.invite_code, invite_used: !!u.invite_used,
        property_id: u.property_id, unit_number: u.unit_number, slot_label: u.slot_label,
        billing_type: u.billing_type, monthly_amount: u.monthly_amount,
        properties: { name: p.name },
        spots,
      },
    });
  } catch (err) {
    console.error('invite-lookup error:', err);
    return reply(500, { error: 'Error looking up invite code. Please try again.' });
  }
};
