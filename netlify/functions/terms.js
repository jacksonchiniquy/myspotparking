// terms.js — parking terms for pages that don't have their own server call.
//   POST { action:'get', propertyId, placement }
//        → { required, version, title, body, rules, propertyName }
//   POST { action:'accept', propertyId, version, plate }   Authorization: Bearer <resident login>
//        → { ok } after recording that a signed-in resident agreed (resident portal)

const terms = require('./lib/terms');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function reply(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) };
}
const svc = () => ({ apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` });

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed' });
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return reply(400, { error: 'Invalid request' }); }
  const propertyId = String(body.propertyId || '');
  if (!UUID_RE.test(propertyId)) return reply(400, { error: 'Property not found.' });

  try {
    if (body.action === 'get') {
      const placement = terms.PLACEMENTS.includes(body.placement) ? body.placement : 'resident_vehicle';
      return reply(200, await terms.termsFor(propertyId, placement));
    }

    if (body.action === 'accept') {
      const jwt = String(event.headers?.authorization || event.headers?.Authorization || '').replace(/^Bearer\s+/i, '');
      if (!jwt) return reply(401, { error: 'Please sign in again.' });
      const ures = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${jwt}` } });
      if (!ures.ok) return reply(401, { error: 'Please sign in again.' });
      const user = await ures.json();
      // Only for a property this resident actually has a permit at
      const pres = await fetch(`${SUPABASE_URL}/rest/v1/permits?holder_id=eq.${user.id}&property_id=eq.${propertyId}&select=id&limit=1`, { headers: svc() });
      const rows = pres.ok ? await pres.json() : [];
      if (!rows.length) return reply(403, { error: 'Property not found.' });
      const err = await terms.checkAccepted(propertyId, 'resident_vehicle', body.version);
      if (err) return reply(400, { error: err, terms: true });
      await terms.recordAcceptance({ propertyId, placement: 'resident_vehicle', version: body.version, plate: body.plate,
        acceptedBy: user.email || 'Resident', userId: user.id, event });
      return reply(200, { ok: true });
    }
    return reply(400, { error: 'Unknown action' });
  } catch (e) {
    console.error('terms error:', e.message);
    return reply(500, { error: 'Something went wrong. Please try again.' });
  }
};
