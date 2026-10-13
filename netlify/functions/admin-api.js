// admin-api.js — admin-only settings that the database won't let the
// browser change directly (only the server or an admin can).
//
// POST { action, ... }   Authorization: Bearer <admin login>
//   setOutsideBilling { propertyId, on }   lets that property's managers "Mark as Paid"

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function reply(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
async function sb(method, path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, ...(method === 'GET' ? {} : { Prefer: 'return=representation' }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${method} ${path.split('?')[0]} ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

// The caller must be signed in with an admin account
async function requireAdmin(event) {
  const jwt = String(event.headers?.authorization || event.headers?.Authorization || '').replace(/^Bearer\s+/i, '');
  if (!jwt) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${jwt}` } });
  if (!res.ok) return null;
  const user = await res.json();
  const [me] = await sb('GET', `users?id=eq.${user.id}&select=id,role`);
  if (me) return me.role === 'admin' ? user : null;
  // Same fallback the admin page uses: profile saved under the (verified) login email
  const [byEmail] = user.email ? await sb('GET', `users?email=eq.${encodeURIComponent(user.email)}&role=eq.admin&select=id`) : [];
  return byEmail ? user : null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed' });
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return reply(400, { error: 'Invalid request' }); }
  try {
    const admin = await requireAdmin(event);
    if (!admin) return reply(403, { error: 'Admin access required. Sign in again.' });

    if (body.action === 'setOutsideBilling') {
      if (!UUID_RE.test(String(body.propertyId || ''))) return reply(400, { error: 'Property not found.' });
      const rows = await sb('PATCH', `properties?id=eq.${body.propertyId}`, { outside_billing: !!body.on });
      if (!rows?.length) return reply(404, { error: 'Property not found.' });
      console.log(`Outside billing ${body.on ? 'ON' : 'OFF'} for ${body.propertyId} by ${admin.email}`);
      const { logActivity, userActor } = require('./lib/activity');
      await logActivity({ ...(await userActor(admin.id)), actorRole: 'admin', portal: 'admin', action: 'billing.outside_billing',
        propertyId: body.propertyId, target: rows[0].name || null, summary: `Turned Outside Billing ${body.on ? 'ON' : 'OFF'}` });
      return reply(200, { ok: true });
    }
    return reply(400, { error: 'Unknown action' });
  } catch (err) {
    console.error('admin-api error:', err);
    return reply(500, { error: 'Something went wrong. Please try again.' });
  }
};
