// admin-api.js — admin-only settings that the database won't let the
// browser change directly (only the server or an admin can).
//
// POST { action, ... }   Authorization: Bearer <admin login>
//   setOutsideBilling { propertyId, on }   lets that property's managers "Mark as Paid"
//   setEnforcementActions { propertyId, actions: ['tow','boot','ticket'] }
//                                          which actions officers can take there
//   setGuestPasses { propertyId, on }      guest passes on/off (adds starter pass types the first time)
//   getTerms / saveTerms { title, body, placements } / previewTerms { propertyId, title, body }
//   setPropertyTerms { propertyId, owner, manager, rules, enabled } / termsAcceptances { propertyId?, plate? }
//                                          Parking Terms wording, per-property names, and who agreed
//   setParkSettings { propertyId, stallMode?, parkCode? }
//                                          Pay to Park stall numbers / property code

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

    // ── Parking terms ──
    if (body.action === 'getTerms') {
      const T = require('./lib/terms');
      let versions = [];
      try { versions = await sb('GET', 'parking_terms?select=version,title,body,placements,created_at,created_by&order=version.desc&limit=25'); }
      catch (e) { return reply(200, { missing: true, versions: [] }); }
      return reply(200, { versions, placements: T.PLACEMENTS });
    }
    if (body.action === 'saveTerms') {
      const T = require('./lib/terms');
      const title = String(body.title || '').trim().slice(0, 120) || 'Parking Terms';
      const text = String(body.body || '').replace(/\r\n/g, '\n').trim();
      if (text.length < 20) return reply(400, { error: 'The terms wording is too short.' });
      if (text.length > 20000) return reply(400, { error: 'The terms wording is too long (20,000 characters max).' });
      const placements = {};
      T.PLACEMENTS.forEach(k => { placements[k] = !!(body.placements && body.placements[k]); });
      const [last] = await sb('GET', 'parking_terms?select=version&order=version.desc&limit=1');
      const version = (last ? last.version : 0) + 1;
      const [row] = await sb('POST', 'parking_terms', { version, title, body: text, placements, created_by: admin.email || 'admin' });
      T.clearCache();
      const { logActivity, userActor } = require('./lib/activity');
      await logActivity({ ...(await userActor(admin.id)), actorRole: 'admin', portal: 'admin', action: 'terms.saved',
        summary: `Saved Parking Terms version ${version}` });
      return reply(200, { ok: true, version: row.version });
    }
    if (body.action === 'previewTerms') {
      if (!UUID_RE.test(String(body.propertyId || ''))) return reply(400, { error: 'Pick a property to preview.' });
      const T = require('./lib/terms');
      const f = await T.fillFor(body.propertyId, { title: String(body.title || 'Parking Terms'), body: String(body.body || '') });
      if (!f) return reply(404, { error: 'Property not found.' });
      return reply(200, { title: f.title, body: f.body, rules: f.rules, values: f.values });
    }
    if (body.action === 'setPropertyTerms') {
      if (!UUID_RE.test(String(body.propertyId || ''))) return reply(400, { error: 'Property not found.' });
      const clean = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
      const patch = { terms_owner: clean(body.owner, 120), terms_manager: clean(body.manager, 120),
        terms_rules: clean(body.rules, 4000), terms_enabled: body.enabled !== false };
      const rows = await sb('PATCH', `properties?id=eq.${body.propertyId}`, patch);
      if (!rows?.length) return reply(404, { error: 'Property not found.' });
      require('./lib/terms').clearCache();
      const { logActivity, userActor } = require('./lib/activity');
      await logActivity({ ...(await userActor(admin.id)), actorRole: 'admin', portal: 'admin', action: 'terms.property',
        propertyId: body.propertyId, target: rows[0].name || null,
        summary: `Updated Parking Terms details${patch.terms_enabled ? '' : ' (terms turned OFF)'}` });
      return reply(200, { ok: true });
    }
    if (body.action === 'termsAcceptances') {
      let path = 'terms_acceptances?select=id,property_id,terms_version,plate,context,accepted_by,ip,created_at&order=created_at.desc&limit=100';
      if (UUID_RE.test(String(body.propertyId || ''))) path += `&property_id=eq.${body.propertyId}`;
      const plate = String(body.plate || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
      if (plate) path += `&plate=eq.${plate}`;
      try { return reply(200, { rows: await sb('GET', path) }); }
      catch (e) { return reply(200, { rows: [], missing: true }); }
    }

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
    if (body.action === 'setEnforcementActions') {
      if (!UUID_RE.test(String(body.propertyId || ''))) return reply(400, { error: 'Property not found.' });
      const ORDER = ['tow', 'boot', 'ticket'];
      const actions = ORDER.filter(a => Array.isArray(body.actions) && body.actions.includes(a));
      if (!actions.length) return reply(400, { error: 'Keep at least one option on (Tow, Boot or Ticket).' });
      const [before] = await sb('GET', `properties?id=eq.${body.propertyId}&select=enforcement_actions`);
      const rows = await sb('PATCH', `properties?id=eq.${body.propertyId}`, { enforcement_actions: actions });
      if (!rows?.length) return reply(404, { error: 'Property not found.' });
      const words = { tow: 'Tow', boot: 'Boot', ticket: 'Ticket' };
      const { logActivity, userActor } = require('./lib/activity');
      await logActivity({ ...(await userActor(admin.id)), actorRole: 'admin', portal: 'admin', action: 'property.enforcement_actions',
        propertyId: body.propertyId, target: rows[0].name || null,
        summary: `Set enforcement options to ${actions.map(a => words[a]).join(', ')}`,
        details: { before: before?.enforcement_actions || null, after: actions } });
      return reply(200, { ok: true, actions });
    }
    if (body.action === 'setGuestPasses') {
      if (!UUID_RE.test(String(body.propertyId || ''))) return reply(400, { error: 'Property not found.' });
      const rows = await sb('PATCH', `properties?id=eq.${body.propertyId}`, { guest_passes_enabled: !!body.on });
      if (!rows?.length) return reply(404, { error: 'Property not found.' });
      let seeded = 0;
      if (body.on) {
        const existing = await sb('GET', `guest_pass_types?property_id=eq.${body.propertyId}&select=id&limit=1`);
        if (!existing.length) {
          // Starter pass types the manager can change or remove
          const starter = [
            { name: 'Day Pass', length_kind: 'hours', hours: 12, allowance: 5, reset_period: 'monthly', sort: 1 },
            { name: 'Night Pass', length_kind: 'window', window_start: '18:00', window_end: '10:00', allowance: 10, reset_period: 'yearly', sort: 2 },
            { name: 'Extended Stay', length_kind: 'dates', max_days: 60, allowance: null, needs_approval: true, sort: 3 },
          ].map(t => ({ // every row needs the same fields for a multi-row insert
            property_id: body.propertyId, hours: null, window_start: null, window_end: null, max_days: null,
            allowance: null, reset_period: 'yearly', needs_approval: false, ...t }));
          await sb('POST', 'guest_pass_types', starter);
          seeded = starter.length;
        }
      }
      const { logActivity, userActor } = require('./lib/activity');
      await logActivity({ ...(await userActor(admin.id)), actorRole: 'admin', portal: 'admin', action: 'property.guest_passes',
        propertyId: body.propertyId, target: rows[0].name || null,
        summary: `Turned Guest Passes ${body.on ? 'ON' : 'OFF'}${seeded ? ' (added starter pass types)' : ''}` });
      return reply(200, { ok: true, seeded });
    }
    if (body.action === 'setParkSettings') {
      if (!UUID_RE.test(String(body.propertyId || ''))) return reply(400, { error: 'Property not found.' });
      const [before] = await sb('GET', `properties?id=eq.${body.propertyId}&select=name,park_code,stall_mode`);
      if (!before) return reply(404, { error: 'Property not found.' });
      const patch = {};
      if (body.stallMode !== undefined) {
        if (!['off', 'optional', 'required'].includes(body.stallMode)) return reply(400, { error: 'Unknown stall setting.' });
        patch.stall_mode = body.stallMode;
      }
      if (body.parkCode !== undefined) {
        const raw = String(body.parkCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        const m = raw.match(/^([A-Z]{3})([0-9]{4})$/);
        if (!m) return reply(400, { error: 'Codes are 3 letters and 4 numbers, like TPP-4821.' });
        patch.park_code = `${m[1]}-${m[2]}`;
        if (patch.park_code !== before.park_code) {
          const taken = await sb('GET', `properties?park_code=eq.${patch.park_code}&id=neq.${body.propertyId}&select=id`);
          if (taken.length) return reply(409, { error: `${patch.park_code} is already used by another property.` });
        }
      }
      if (!Object.keys(patch).length) return reply(400, { error: 'Nothing to change.' });
      const rows = await sb('PATCH', `properties?id=eq.${body.propertyId}`, patch);
      const words = { off: 'Off', optional: 'Optional', required: 'Required' };
      const said = [];
      if (patch.stall_mode && patch.stall_mode !== before.stall_mode) said.push(`stall numbers ${words[before.stall_mode] || 'Off'} → ${words[patch.stall_mode]}`);
      if (patch.park_code && patch.park_code !== before.park_code) said.push(`property code ${before.park_code || '(none)'} → ${patch.park_code}`);
      if (said.length) {
        const { logActivity, userActor } = require('./lib/activity');
        await logActivity({ ...(await userActor(admin.id)), actorRole: 'admin', portal: 'admin', action: 'property.park_settings',
          propertyId: body.propertyId, target: before.name || null, summary: 'Changed Pay to Park ' + said.join(', '),
          details: { before: { park_code: before.park_code, stall_mode: before.stall_mode }, after: patch } });
      }
      return reply(200, { ok: true, property: rows[0] });
    }
    return reply(400, { error: 'Unknown action' });
  } catch (err) {
    console.error('admin-api error:', err);
    return reply(500, { error: 'Something went wrong. Please try again.' });
  }
};
