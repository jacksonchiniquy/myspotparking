// guest-pass.js — a guest uses the code a resident gave them (guest.html / /park)
//   POST { code }                               → what the code is for
//   POST { code, plate, state?, vehicle? }      → activate it for that vehicle
//   POST { code, email }                        → email the active pass to the guest
// Codes are single-use: one vehicle per code.

const GP = require('./lib/guest-passes');
const { sb } = require('./lib/parking');
const { sendRaw, logoHeader } = require('./send-email');
const { logActivity } = require('./lib/activity');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function reply(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) };
}

async function load(code) {
  const [g] = await sb('GET', `guest_passes?code=eq.${encodeURIComponent(code)}&select=*`);
  if (!g) return null;
  const [property] = await sb('GET', `properties?id=eq.${g.property_id}&select=name,address,space_word,guest_passes_enabled,guest_rules`);
  const [type] = g.pass_type_id ? await sb('GET', `guest_pass_types?id=eq.${g.pass_type_id}&select=*`) : [];
  const word = ((property && property.space_word) || 'Unit').trim() || 'Unit';
  return { g, property: property || {}, type: type || { name: 'Guest Pass', length_kind: 'hours', hours: 24 }, unitLabel: `${word} ${g.unit_number}` };
}

function view(ctx, extra = {}) {
  const { g, property, type, unitLabel } = ctx;
  return {
    propertyName: property.name || '', propertyAddress: property.address || '', unitLabel, typeName: type.name,
    describe: GP.describeType(type), status: g.status,
    plate: g.guest_plate || null, state: g.guest_state || null, vehicle: g.guest_vehicle || null,
    starts: g.starts_at ? GP.fmtWhen(g.starts_at) : null, ends: g.ends_at ? GP.fmtWhen(g.ends_at) : null,
    startsLater: g.starts_at ? new Date(g.starts_at) > new Date() : false,
    emailed: !!g.guest_email, ...extra,
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed' });
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return reply(400, { error: 'Invalid request' }); }
  const code = GP.normalizeCode(body.code);
  if (!code) return reply(404, { error: "That guest code doesn't look right. Guest codes look like G-7KQ4-92." });
  try {
    const ctx = await load(code);
    if (!ctx) return reply(404, { error: "We couldn't find that guest code. Check it with the person who sent it." });
    const { g, property, type } = ctx;
    const now = new Date();

    // ── Email the pass ──
    if (body.email !== undefined) {
      const email = String(body.email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(email)) return reply(400, { error: 'Enter a valid email address.' });
      if (g.status !== 'active') return reply(400, { error: 'Activate the pass first.' });
      const msg = GP.passEmail(g, { propertyName: property.name || '', unitLabel: ctx.unitLabel, typeName: type.name, logoHeader });
      await sendRaw({ to: email, ...msg });
      await sb('PATCH', `guest_passes?id=eq.${g.id}`, { guest_email: email });
      return reply(200, { ok: true });
    }

    // ── Look up ──
    if (body.plate === undefined) {
      if (g.status === 'active' || g.status === 'ended') return reply(200, view(ctx));
      if (g.status === 'cancelled') return reply(410, { error: 'This guest code was cancelled by the resident.' });
      if (g.status === 'expired' || (g.code_expires_at && new Date(g.code_expires_at) <= now))
        return reply(410, { error: 'This guest code has expired. Ask the resident for a new one.' });
      if (!property.guest_passes_enabled) return reply(410, { error: 'Guest passes are no longer offered at this property.' });
      const w = GP.passWindow(type, now);
      const terms = await require('./lib/terms').termsFor(g.property_id, 'guest');
      return reply(200, view(ctx, { terms, preview: w ? { starts: GP.fmtWhen(w.starts), ends: GP.fmtWhen(w.ends), startsLater: w.starts > now } : null }));
    }

    // ── Activate ──
    if (g.status !== 'issued') return reply(409, { error: g.status === 'active' ? 'This code has already been used for a vehicle.' : 'This guest code can no longer be used.' });
    if (g.code_expires_at && new Date(g.code_expires_at) <= now) return reply(410, { error: 'This guest code has expired. Ask the resident for a new one.' });
    if (!property.guest_passes_enabled) return reply(410, { error: 'Guest passes are no longer offered at this property.' });
    const plate = GP.normPlate(body.plate);
    if (plate.length < 2) return reply(400, { error: 'Enter your license plate.' });
    const terms = require('./lib/terms');
    const termsErr = await terms.checkAccepted(g.property_id, 'guest', body.termsVersion);
    if (termsErr) return reply(400, { error: termsErr, terms: true });

    const limit = (property.guest_rules || {}).plate_month_limit;
    if (limit !== null && limit !== undefined && limit !== '') {
      const since = GP.monthStart(now).toISOString();
      const rows = await sb('GET', `guest_passes?property_id=eq.${g.property_id}&guest_plate=eq.${plate}&activated_at=gte.${since}&status=in.(active,ended)&select=id`);
      if (rows.length >= Number(limit)) {
        await logActivity({ actorRole: 'guest', portal: 'guest', action: 'guest.plate_limit', propertyId: g.property_id, target: plate,
          summary: `Guest pass refused: ${plate} already had ${rows.length} guest pass${rows.length === 1 ? '' : 'es'} this month (limit ${limit})` }).catch(() => {});
        return reply(403, { error: `This vehicle has reached this property's guest pass limit for the month. Please contact the property manager.` });
      }
    }

    const w = GP.passWindow(type, now) || { starts: now, ends: new Date(now.getTime() + 24 * 3600e3) };
    const state = String(body.state || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2) || null;
    const vehicle = typeof body.vehicle === 'string' && body.vehicle.trim() ? body.vehicle.trim().slice(0, 60) : null;
    // Only succeeds if nobody used the code a moment ago
    const updated = await sb('PATCH', `guest_passes?id=eq.${g.id}&status=eq.issued`, {
      status: 'active', guest_plate: plate, guest_state: state, guest_vehicle: vehicle,
      starts_at: w.starts.toISOString(), ends_at: w.ends.toISOString(), activated_at: now.toISOString(),
    });
    if (!updated || !updated.length) return reply(409, { error: 'This code has already been used for a vehicle.' });
    await logActivity({ actorName: `Guest (${plate})`, actorRole: 'guest', portal: 'guest', action: 'guest.activated', propertyId: g.property_id,
      target: ctx.unitLabel, summary: `Guest activated ${type.name} ${code} for ${plate}${vehicle ? ' (' + vehicle + ')' : ''}` }).catch(() => {});
    await terms.recordAcceptance({ propertyId: g.property_id, placement: 'guest', version: body.termsVersion, plate,
      acceptedBy: `Guest of ${ctx.unitLabel}`, event });
    ctx.g = updated[0];
    return reply(200, view(ctx));
  } catch (err) {
    console.error('guest-pass error:', err.message);
    return reply(500, { error: 'Something went wrong. Please try again.' });
  }
};
