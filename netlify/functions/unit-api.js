// unit-api.js — private service behind the Unit Portal (unit.html).
//
// The unit portal used to read and write the database directly from the
// browser, which required the database to be open to everyone. Now every
// unit action goes through here: the password is checked on the server,
// the browser gets a signed, expiring session token, and each request is
// limited to that one unit.
//
// POST { action, token?, ...fields }
//   login    { propertyId, unitNumber, password }       → { token, propertyName, unitNumber }
//   load     { token }                                   → { slots, unitPermits, vehicles, tenantEmail, propertyName }
//   addVehicle / editVehicle / deleteVehicle { token, ... }
//   assign   { token, slotId, vehicleId }
//   saveEmail { token, email }
//   changePassword { token, password }
//   forgot   { propertyId, unitNumber, email }
//   managerAssign { slotId, plate, desc }   (Authorization: Bearer <manager or admin login>)
//   managerVoid   { slotId }                (Authorization: Bearer <manager or admin login>)
//   addSpotCheckout { token, slotId }        → { url }  resident pays for a paid spot they skipped
//   billingPortal   { token }                → { url }  resident's Stripe billing page
//   managerSendSpotLink { slotId, email? }   emails the resident a "Pay & Add Spot" link
//   managerMarkPaid / managerMarkUnpaid { slotId }  outside billing (admin must allow it per property)
//   managerMoveOutPreview / managerMoveOut { slotId }  tenant turnover for the whole unit

const crypto = require('crypto');
const { hashPassword, verifyPassword, isHashed, generatePassword } = require('./lib/unit-password');
const { send, sendRaw, logoHeader } = require('./send-email');
const { createSpotCheckout, unitCustomer, spotProblem, makePayLink } = require('./lib/spot-checkout');
const { spotMonthlyCents } = require('./lib/spot-pricing');
const stripe = () => require('stripe')(process.env.STRIPE_SECRET_KEY);
const SITE = process.env.SITE_URL || 'https://myspotparking.com';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SESSION_HOURS = 12;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── Responses ────────────────────────────────────────────────
function reply(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
class UserError extends Error { constructor(msg, code = 400) { super(msg); this.code = code; } }

// ── Supabase (service key, server only) ──────────────────────
function headers(extra = {}) {
  return { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, ...extra };
}
async function sb(method, path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method, headers: headers(method === 'GET' ? {} : { Prefer: 'return=representation' }),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${method} ${path.split('?')[0]} ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}
const q = encodeURIComponent;

// ── Session tokens ───────────────────────────────────────────
// Signed with a key derived from the service key, so no extra setup is needed.
const TOKEN_KEY = () => crypto.createHash('sha256').update('unit-session:' + SUPABASE_KEY).digest();
const b64 = s => Buffer.from(s).toString('base64url');
// "pv" ties a token to the current password: changing the password signs out other devices.
const passwordVersion = stored => crypto.createHash('sha256').update(String(stored || '')).digest('hex').slice(0, 12);

function makeToken(propertyId, unitNumber, storedPassword) {
  const payload = b64(JSON.stringify({ p: propertyId, u: unitNumber, pv: passwordVersion(storedPassword), exp: Date.now() + SESSION_HOURS * 3600e3 }));
  const sig = crypto.createHmac('sha256', TOKEN_KEY()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function readToken(token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) throw new UserError('Please sign in again.', 401);
  const expect = crypto.createHmac('sha256', TOKEN_KEY()).update(payload).digest('base64url');
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) throw new UserError('Please sign in again.', 401);
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
  if (!data.exp || data.exp < Date.now()) throw new UserError('Your session expired. Please sign in again.', 401);
  return data;
}

// ── Unit helpers ─────────────────────────────────────────────
async function getSlots(propertyId, unitNumber) {
  return sb('GET', `property_units?property_id=eq.${q(propertyId)}&unit_number=eq.${q(unitNumber)}&select=*&order=slot_label`);
}
const passwordSlot = slots => slots.find(s => s.unit_password) || slots[0];

// Loads the unit for a request and confirms the token is still valid for it
async function authUnit(token) {
  const t = readToken(token);
  const slots = await getSlots(t.p, t.u);
  if (!slots.length) throw new UserError('This unit no longer exists. Contact your property manager.', 401);
  if (passwordVersion(passwordSlot(slots).unit_password) !== t.pv) throw new UserError('Your password was changed. Please sign in again.', 401);
  return { propertyId: t.p, unitNumber: t.u, slots };
}

// What the browser is allowed to see about a slot (no password, no invite code)
function publicSlot(s) {
  return {
    id: s.id, slot_label: s.slot_label, slot_type: s.slot_type, managed_by: s.managed_by,
    max_vehicles: s.max_vehicles, billing_type: s.billing_type, monthly_amount: s.monthly_amount,
    needs_payment: s.billing_type === 'monthly' && s.spot_paid === false,
    paid_via: s.paid_via || null,
  };
}

function vehicleFields(v) {
  const plate = String(v.plate || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 10);
  if (!plate) throw new UserError('Enter a license plate.');
  const s = (x, n) => (typeof x === 'string' && x.trim() ? x.trim().slice(0, n) : null);
  return {
    plate, plate_state: s(v.plate_state, 20), make: s(v.make, 40), model: s(v.model, 40),
    year: s(v.year, 4), color: s(v.color, 30), vin_last6: s(v.vin_last6, 6),
  };
}

async function propertyName(propertyId) {
  const rows = await sb('GET', `properties?id=eq.${q(propertyId)}&select=name`);
  return rows?.[0]?.name || 'Property';
}

// ── Assign a vehicle to a slot (one permit per slot) ─────────
// Shared rules with the manager portal:
//  1. If the slot already has a vehicle with a permit, that permit is updated to the new car.
//  2. Otherwise reuse an active permit for this unit that isn't tied to another slot
//     (e.g. the one created at sign-up, so billing stays linked).
//  3. Otherwise create a new permit, copying billing links from the unit's other permits.
async function assignToSlot({ propertyId, unitNumber, slots, slotId, vehicle, assignedBy }) {
  const slot = slots.find(s => s.id === slotId);
  if (!slot) throw new UserError('That parking spot is not part of this unit.', 403);
  const slotIds = slots.map(s => s.id);
  const activeUps = await sb('GET', `unit_permits?unit_slot_id=in.(${slotIds.join(',')})&void_at=is.null&select=*`);
  const current = activeUps.find(up => up.unit_slot_id === slotId);
  const usedPermitIds = new Set(activeUps.filter(up => up.unit_slot_id !== slotId && up.permit_id).map(up => up.permit_id));

  const desc = vehicle.desc || [vehicle.year, vehicle.make, vehicle.model, vehicle.color].filter(Boolean).join(' ') || null;
  const permitFields = {
    plate: vehicle.plate, plate_state: vehicle.plate_state || null, vehicle: desc,
    vehicle_make: vehicle.make || null, vehicle_model: vehicle.model || null,
    vehicle_year: vehicle.year || null, vehicle_color: vehicle.color || null,
    vin_last6: vehicle.vin_last6 || null, status: 'active',
  };

  const unitPermits = await sb('GET', `permits?property_id=eq.${q(propertyId)}&unit_number=eq.${q(unitNumber)}&select=*&order=created_at`);
  let permitId = null;
  const linked = current?.permit_id && unitPermits.find(p => p.id === current.permit_id);
  const reusable = unitPermits.find(p => p.status === 'active' && !usedPermitIds.has(p.id));

  if (linked) {
    permitId = linked.id;
    await sb('PATCH', `permits?id=eq.${permitId}`, permitFields);
  } else if (reusable) {
    permitId = reusable.id;
    await sb('PATCH', `permits?id=eq.${permitId}`, permitFields);
  } else {
    const billingSource = unitPermits.find(p => p.stripe_subscription_id) || {};
    const today = new Date();
    const end = new Date(today); end.setFullYear(end.getFullYear() + 1);
    const created = await sb('POST', 'permits', {
      property_id: propertyId, unit_number: unitNumber, ...permitFields,
      permit_type: slot.billing_type === 'monthly' ? 'Resident — Monthly' : 'Resident — Unit',
      plan: slot.billing_type === 'monthly' ? 'monthly' : 'none',
      source: assignedBy === 'manager' ? 'unit-manager' : 'unit-self',
      start_date: today.toISOString().slice(0, 10), end_date: end.toISOString().slice(0, 10),
      ...(billingSource.stripe_subscription_id ? { stripe_subscription_id: billingSource.stripe_subscription_id } : {}),
      ...(billingSource.holder_email ? { holder_email: billingSource.holder_email } : {}),
      ...(billingSource.holder_id ? { holder_id: billingSource.holder_id } : {}),
    });
    permitId = created?.[0]?.id || null;
  }

  if (current) await sb('PATCH', `unit_permits?id=eq.${current.id}`, { void_at: new Date().toISOString() });
  await sb('POST', 'unit_permits', {
    unit_slot_id: slotId, permit_id: permitId, plate: vehicle.plate,
    vehicle_desc: desc, vin_last6: vehicle.vin_last6 || null, assigned_by: assignedBy,
  });
  return permitId;
}

// ── Manager / admin callers ──────────────────────────────────
// Confirms the caller is logged in as the manager of this slot's property (or an admin).
async function authManagerForSlot(event, slotId) {
  const auth = event.headers?.authorization || event.headers?.Authorization || '';
  const jwt = auth.replace(/^Bearer\s+/i, '');
  if (!jwt) throw new UserError('Please sign in again.', 401);
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${jwt}` } });
  if (!res.ok) throw new UserError('Please sign in again.', 401);
  const { id: userId } = await res.json();
  if (!UUID_RE.test(String(slotId || ''))) throw new UserError('Slot not found.');
  const [me] = await sb('GET', `users?id=eq.${userId}&select=role`);
  const [slot] = await sb('GET', `property_units?id=eq.${slotId}&select=property_id,unit_number`);
  if (!slot) throw new UserError('Slot not found.', 404);
  const [prop] = await sb('GET', `properties?id=eq.${slot.property_id}&select=manager_id`);
  if (me?.role !== 'admin' && !(me?.role === 'manager' && prop?.manager_id === userId)) throw new UserError('Not allowed.', 403);
  const slots = await getSlots(slot.property_id, slot.unit_number);
  return { propertyId: slot.property_id, unitNumber: slot.unit_number, slots, slot: slots.find(x => x.id === slotId), userId };
}

async function propertyRow(propertyId) {
  const [p] = await sb('GET', `properties?id=eq.${q(propertyId)}&select=*`);
  return p || {};
}
const escH = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ── Move-out helpers ─────────────────────────────────────────
function newInviteCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) { if (i === 4) code += '-'; code += chars[crypto.randomInt(chars.length)]; }
  return code;
}
async function moveOutSummary(u) {
  const slotIds = u.slots.map(x => x.id);
  const [vehicles, ups, permits] = await Promise.all([
    sb('GET', `unit_vehicles?property_id=eq.${q(u.propertyId)}&unit_number=eq.${q(u.unitNumber)}&select=plate,make,model,year,color`),
    sb('GET', `unit_permits?unit_slot_id=in.(${slotIds.join(',')})&select=plate,vehicle_desc,created_at,void_at`),
    sb('GET', `permits?property_id=eq.${q(u.propertyId)}&unit_number=eq.${q(u.unitNumber)}&status=eq.active&select=id,plate,stripe_subscription_id`),
  ]);
  const subs = new Set();
  u.slots.forEach(x => { if (x.spot_subscription_id) subs.add(x.spot_subscription_id); });
  permits.forEach(p => { if (p.stripe_subscription_id) subs.add(p.stripe_subscription_id); });
  const tenant = u.slots.find(x => x.tenant_name || x.tenant_email) || {};
  // Cars from this tenancy: saved vehicles, active spot assignments, and any spot
  // assignment made since the unit was last moved out
  const [last] = await sb('GET', `unit_tenancies?property_id=eq.${q(u.propertyId)}&unit_number=eq.${q(u.unitNumber)}&select=moved_out_at&order=moved_out_at.desc&limit=1`).catch(() => []);
  const since = last ? new Date(last.moved_out_at) : null;
  const byPlate = new Map();
  const add = (plate, desc) => {
    const p = String(plate || '').toUpperCase(); if (!p) return;
    if (!byPlate.has(p) || (!byPlate.get(p) && desc)) byPlate.set(p, desc || null);
  };
  vehicles.forEach(v => add(v.plate, [v.year, v.make, v.model, v.color].filter(Boolean).join(' ')));
  ups.filter(up => !up.void_at || !since || new Date(up.created_at) > since).forEach(up => add(up.plate, up.vehicle_desc));
  permits.forEach(p => add(p.plate, null));
  const plates = [...byPlate.keys()];
  return {
    unitNumber: u.unitNumber,
    tenantName: tenant.tenant_name || null, tenantEmail: tenant.tenant_email || null,
    signedUp: u.slots.some(x => x.invite_used || x.unit_password),
    plates,
    vehicles: [...byPlate].map(([plate, desc]) => ({ plate, desc })),
    paidSpots: u.slots.filter(x => x.spot_paid).map(x => ({ label: x.slot_label || 'Spot', via: x.paid_via || 'card', amount: x.monthly_amount })),
    cardBilling: subs.size,
    _subscriptions: [...subs],
  };
}

// ── Actions ──────────────────────────────────────────────────
const actions = {
  async login({ propertyId, unitNumber, password }) {
    unitNumber = String(unitNumber || '').trim();
    if (!UUID_RE.test(String(propertyId || '')) || !unitNumber || !password) throw new UserError('Enter your property, unit number and password.');
    const slots = await getSlots(propertyId, unitNumber);
    if (!slots.length) throw new UserError('Unit not found for this property. Contact your property manager.');
    const slot = passwordSlot(slots);
    if (!slot.unit_password) throw new UserError('No password set for this unit. Contact your property manager.');
    if (!verifyPassword(password, slot.unit_password)) throw new UserError('Incorrect password. Check with your property manager.');
    let stored = slot.unit_password;
    if (!isHashed(stored)) {
      // Upgrade a legacy plain-text password to the scrambled form
      stored = hashPassword(password);
      await sb('PATCH', `property_units?property_id=eq.${q(propertyId)}&unit_number=eq.${q(unitNumber)}&unit_password=not.is.null`, { unit_password: stored });
    }
    return { token: makeToken(propertyId, unitNumber, stored), propertyName: await propertyName(propertyId), unitNumber };
  },

  async load({ token }) {
    const u = await authUnit(token);
    const slotIds = u.slots.map(s => s.id);
    const [ups, vehicles] = await Promise.all([
      sb('GET', `unit_permits?unit_slot_id=in.(${slotIds.join(',')})&void_at=is.null&select=id,unit_slot_id,plate,vehicle_desc,vin_last6,assigned_by,created_at`),
      sb('GET', `unit_vehicles?property_id=eq.${q(u.propertyId)}&unit_number=eq.${q(u.unitNumber)}&select=*&order=created_at`),
    ]);
    const unitPermits = {};
    ups.forEach(up => { unitPermits[up.unit_slot_id] = up; });
    return {
      slots: u.slots.map(publicSlot), unitPermits, vehicles,
      tenantEmail: u.slots.find(s => s.tenant_email)?.tenant_email || '',
      propertyName: await propertyName(u.propertyId), unitNumber: u.unitNumber,
    };
  },

  async addVehicle({ token, vehicle }) {
    const u = await authUnit(token);
    await sb('POST', 'unit_vehicles', { property_id: u.propertyId, unit_number: u.unitNumber, ...vehicleFields(vehicle || {}) });
    return { ok: true };
  },

  async editVehicle({ token, id, vehicle }) {
    const u = await authUnit(token);
    if (!UUID_RE.test(String(id || ''))) throw new UserError('Vehicle not found.');
    const rows = await sb('PATCH', `unit_vehicles?id=eq.${id}&property_id=eq.${q(u.propertyId)}&unit_number=eq.${q(u.unitNumber)}`, vehicleFields(vehicle || {}));
    if (!rows?.length) throw new UserError('Vehicle not found.', 404);
    return { ok: true };
  },

  async deleteVehicle({ token, id }) {
    const u = await authUnit(token);
    if (!UUID_RE.test(String(id || ''))) throw new UserError('Vehicle not found.');
    const rows = await sb('DELETE', `unit_vehicles?id=eq.${id}&property_id=eq.${q(u.propertyId)}&unit_number=eq.${q(u.unitNumber)}`);
    if (!rows?.length) throw new UserError('Vehicle not found.', 404);
    return { ok: true };
  },

  async assign({ token, slotId, vehicleId }) {
    const u = await authUnit(token);
    const slot = u.slots.find(s => s.id === slotId);
    if (!slot) throw new UserError('That parking spot is not part of this unit.', 403);
    if (slot.managed_by === 'manager') throw new UserError('This spot is manager-assigned. Contact your property manager.', 403);
    if (slot.billing_type === 'monthly' && slot.spot_paid === false) {
      throw new UserError('This is a paid spot that isn\'t paid for yet. Contact your property manager to add it.', 403);
    }
    if (!UUID_RE.test(String(vehicleId || ''))) throw new UserError('Select a vehicle first.');
    const veh = await sb('GET', `unit_vehicles?id=eq.${vehicleId}&property_id=eq.${q(u.propertyId)}&unit_number=eq.${q(u.unitNumber)}&select=*`);
    if (!veh?.length) throw new UserError('Vehicle not found.', 404);
    await assignToSlot({ ...u, slotId, vehicle: veh[0], assignedBy: 'tenant' });
    return { ok: true, plate: veh[0].plate };
  },

  async saveEmail({ token, email }) {
    const u = await authUnit(token);
    email = String(email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new UserError('Enter a valid email address.');
    await sb('PATCH', `property_units?property_id=eq.${q(u.propertyId)}&unit_number=eq.${q(u.unitNumber)}`, { tenant_email: email });
    return { ok: true };
  },

  async changePassword({ token, password }) {
    const u = await authUnit(token);
    if (typeof password !== 'string' || password.length < 6) throw new UserError('Password must be at least 6 characters.');
    const stored = hashPassword(password);
    await sb('PATCH', `property_units?property_id=eq.${q(u.propertyId)}&unit_number=eq.${q(u.unitNumber)}`, { unit_password: stored });
    // New token so this device stays signed in; other devices are signed out
    return { ok: true, token: makeToken(u.propertyId, u.unitNumber, stored) };
  },

  async forgot({ propertyId, unitNumber, email }) {
    unitNumber = String(unitNumber || '').trim();
    email = String(email || '').trim().toLowerCase();
    if (!UUID_RE.test(String(propertyId || '')) || !unitNumber || !EMAIL_RE.test(email)) throw new UserError('Enter your property, unit number and email.');
    const slots = await getSlots(propertyId, unitNumber);
    if (!slots.length) throw new UserError('Unit not found for this property.');
    const onFile = slots.find(s => s.tenant_email)?.tenant_email;
    if (!onFile) throw new UserError('No email address is on file for this unit. Contact your property manager.');
    if (onFile.toLowerCase() !== email) throw new UserError('That email does not match what we have on file for this unit.');
    const password = generatePassword();
    // Email first, so a failed email never leaves the resident locked out
    await send({
      type: 'passwordReset', to: onFile,
      data: { name: slots.find(s => s.tenant_name)?.tenant_name || 'Resident', password, propertyName: await propertyName(propertyId), unitNumber },
    });
    await sb('PATCH', `property_units?property_id=eq.${q(propertyId)}&unit_number=eq.${q(unitNumber)}`, { unit_password: hashPassword(password) });
    return { ok: true, sentTo: onFile };
  },

  async managerAssign({ slotId, plate, desc }, event) {
    const u = await authManagerForSlot(event, slotId);
    const vehicle = { ...vehicleFields({ plate }), desc: typeof desc === 'string' && desc.trim() ? desc.trim().slice(0, 120) : null };
    await assignToSlot({ ...u, slotId, vehicle, assignedBy: 'manager' });
    return { ok: true };
  },

  // ── Paid spots added after sign-up ─────────────────────────
  async addSpotCheckout({ token, slotId }) {
    const u = await authUnit(token);
    const slot = u.slots.find(x => x.id === slotId);
    const problem = spotProblem(slot);
    if (problem) throw new UserError(problem);
    try {
      const checkout = await createSpotCheckout(stripe(), {
        slot, property: await propertyRow(u.propertyId), email: u.slots.find(x => x.tenant_email)?.tenant_email || null,
        successUrl: `${SITE}/unit.html?spot_added=1`, cancelUrl: `${SITE}/unit.html`,
      });
      return { url: checkout.url };
    } catch (e) { if (e.user) throw new UserError(e.message); throw e; }
  },

  async billingPortal({ token }) {
    const u = await authUnit(token);
    const customer = await unitCustomer(u.propertyId, u.unitNumber);
    if (!customer) throw new UserError('There is no card billing on this unit yet.');
    const session = await stripe().billingPortal.sessions.create({ customer, return_url: `${SITE}/unit.html` });
    return { url: session.url };
  },

  async managerSendSpotLink({ slotId, email }, event) {
    const u = await authManagerForSlot(event, slotId);
    const problem = spotProblem(u.slot);
    if (problem) throw new UserError(problem);
    if (!u.slots.some(x => x.invite_used || x.unit_password)) {
      throw new UserError('This unit hasn\'t signed up yet. Send them the invite instead — they can choose paid spots when they sign up.');
    }
    const to = String(email || u.slots.find(x => x.tenant_email)?.tenant_email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(to)) throw new UserError('Enter the resident\'s email address.');
    const property = await propertyRow(u.propertyId);
    const price = `$${(spotMonthlyCents(u.slot, property) / 100).toFixed(2)} / month`;
    const link = makePayLink(u.slot.id);
    const spot = `${u.slot.slot_label || 'Spot'}`;
    const typeName = String(u.slot.slot_type || '').replace(/^(stall|zone)-/, '').replace(/\b\w/g, c => c.toUpperCase());
    await sendRaw({
      to,
      subject: `${spot} has been added to Unit ${u.unitNumber} — complete payment`,
      html: `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 16px;color:#0f172a;background:#ffffff;">
  ${logoHeader('#1a6fff')}
  <h2 style="margin:0 0 8px;">${escH(spot)} has been added to Unit ${escH(u.unitNumber)}</h2>
  <p style="color:#475569;margin:0 0 20px;line-height:1.5;">Your property manager at <strong>${escH(property.name || 'your property')}</strong> added a parking spot to your unit. Complete payment to start using it.</p>
  <div style="background:#f4f7ff;border-radius:10px;padding:14px 20px;margin-bottom:22px;"><table width="100%" cellpadding="0" cellspacing="0">
    <tr><td style="padding:5px 0;color:#64748b;font-size:13px;">Spot</td><td style="padding:5px 0;text-align:right;font-weight:700;">${escH(spot)}${typeName ? ' · ' + escH(typeName) : ''}</td></tr>
    <tr><td style="padding:5px 0;color:#64748b;font-size:13px;">Price</td><td style="padding:5px 0;text-align:right;font-weight:700;">${price}</td></tr></table></div>
  <p style="text-align:center;margin:0 0 20px;"><a href="${link}" style="display:inline-block;background:#1a6fff;color:#ffffff;text-decoration:none;padding:13px 28px;border-radius:9px;font-weight:700;">Pay &amp; Add Spot →</a></p>
  <p style="color:#94a3b8;font-size:12px;text-align:center;">Billed monthly by card through Stripe. Cancel anytime from Manage Billing in your unit portal. This link works for 30 days.</p>
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;">
  <p style="color:#94a3b8;font-size:11px;text-align:center;">© ${new Date().getFullYear()} My Spot Parking Inc.</p>
</body></html>`,
      text: `${spot} has been added to Unit ${u.unitNumber} at ${property.name || 'your property'} (${price}).\n\nPay and add the spot: ${link}\n\nBilled monthly by card. This link works for 30 days.`,
    });
    if (!u.slots.some(x => x.tenant_email)) {
      await sb('PATCH', `property_units?property_id=eq.${q(u.propertyId)}&unit_number=eq.${q(u.unitNumber)}`, { tenant_email: to });
    }
    return { ok: true, sentTo: to };
  },

  async managerMarkPaid({ slotId }, event) {
    const u = await authManagerForSlot(event, slotId);
    if (!(await propertyRow(u.propertyId)).outside_billing) {
      throw new UserError('Outside billing isn\'t turned on for this property. Contact My Spot Parking to set it up.', 403);
    }
    const problem = spotProblem(u.slot);
    if (problem) throw new UserError(problem);
    await sb('PATCH', `property_units?id=eq.${u.slot.id}`, { spot_paid: true, paid_via: 'manual' });
    return { ok: true };
  },

  async managerMarkUnpaid({ slotId }, event) {
    const u = await authManagerForSlot(event, slotId);
    if (!u.slot?.spot_paid) throw new UserError('This spot isn\'t marked paid.');
    if (u.slot.paid_via !== 'manual') {
      throw new UserError('This spot is paid by card. The resident can cancel it from Manage Billing in their unit portal.');
    }
    await sb('PATCH', `property_units?id=eq.${u.slot.id}`, { spot_paid: false, paid_via: null });
    return { ok: true };
  },

  // ── Tenant move-out (turnover) ─────────────────────────────
  async managerMoveOutPreview({ slotId }, event) {
    const u = await authManagerForSlot(event, slotId);
    const { _subscriptions, vehicles, ...summary } = await moveOutSummary(u);
    return summary;
  },

  async managerMoveOut({ slotId }, event) {
    const u = await authManagerForSlot(event, slotId);
    const sum = await moveOutSummary(u);
    const st = stripe();

    // 0. Save the tenant's record first. If it can't be saved, nothing is cleared.
    const [me] = await sb('GET', `users?id=eq.${u.userId}&select=*`);
    const movedIn = u.slots.map(x => x.invite_used_at).filter(Boolean).sort()[0] || null;
    try {
      await sb('POST', 'unit_tenancies', {
        property_id: u.propertyId, unit_number: u.unitNumber,
        tenant_name: sum.tenantName, tenant_email: sum.tenantEmail,
        moved_in_at: movedIn, moved_out_at: new Date().toISOString(),
        vehicles: sum.vehicles,
        spots: u.slots.map(x => ({
          label: x.slot_label || 'Spot', type: x.slot_type || null, billing: x.billing_type || 'free',
          amount: x.monthly_amount ?? null, paid: !!x.spot_paid, via: x.spot_paid ? (x.paid_via || 'card') : null,
        })),
        moved_out_by: u.userId, moved_out_by_name: me?.full_name || me?.name || me?.email || null,
      });
    } catch (e) {
      console.error('Saving tenant history failed:', e.message);
      throw new UserError('Couldn\'t save the tenant history, so nothing was changed. Please try again.', 500);
    }

    // 1. Stop the old tenant's card billing (marked so the webhook doesn't send "suspended" emails)
    const cancelFailed = [];
    for (const subId of sum._subscriptions) {
      try {
        await st.subscriptions.update(subId, { metadata: { moved_out: '1' } });
        await st.subscriptions.cancel(subId);
      } catch (e) {
        if (!/No such subscription|canceled/i.test(e.message || '')) { cancelFailed.push(subId); console.error('Move-out cancel failed', subId, e.message); }
      }
    }
    // 2. Their cars are no longer valid to enforcement
    const slotIds = u.slots.map(x => x.id);
    await sb('PATCH', `unit_permits?unit_slot_id=in.(${slotIds.join(',')})&void_at=is.null`, { void_at: new Date().toISOString() });
    await sb('PATCH', `permits?property_id=eq.${q(u.propertyId)}&unit_number=eq.${q(u.unitNumber)}&status=eq.active`,
      { status: 'revoked', ...(sum._subscriptions.length ? { billing_status: 'suspended' } : {}) });
    // 3. Clear their saved vehicles
    await sb('DELETE', `unit_vehicles?property_id=eq.${q(u.propertyId)}&unit_number=eq.${q(u.unitNumber)}`);
    // 4. Sign them out, clear tenant info and paid spots, new invite for the next tenant
    await sb('PATCH', `property_units?property_id=eq.${q(u.propertyId)}&unit_number=eq.${q(u.unitNumber)}`, {
      unit_password: null, invite_used: false, invite_used_at: null, tenant_email: null, tenant_name: null,
      spot_paid: false, paid_via: null, spot_subscription_id: null, stripe_customer_id: null,
    });
    const inviteSlot = u.slots.find(x => x.invite_code) || u.slots[0];
    let code = null;
    for (let i = 0; i < 3 && !code; i++) {
      const c = newInviteCode();
      try { await sb('PATCH', `property_units?id=eq.${inviteSlot.id}`, { invite_code: c }); code = c; }
      catch (e) { if (!/duplicate|unique/i.test(e.message)) throw e; }
    }
    return { ok: true, inviteCode: code, cancelFailed };
  },

  async managerVoid({ slotId }, event) {
    const u = await authManagerForSlot(event, slotId);
    const ups = await sb('PATCH', `unit_permits?unit_slot_id=eq.${slotId}&void_at=is.null`, { void_at: new Date().toISOString() });
    // The plate that was in this spot should no longer show as valid to enforcement
    const ids = (ups || []).map(up => up.permit_id).filter(Boolean);
    if (ids.length) await sb('PATCH', `permits?id=in.(${ids.join(',')})&property_id=eq.${q(u.propertyId)}`, { status: 'revoked' });
    return { ok: true };
  },
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed' });
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return reply(400, { error: 'Invalid request' }); }
  const fn = actions[body.action];
  if (!fn) return reply(400, { error: 'Unknown action' });
  try {
    return reply(200, await fn(body, event));
  } catch (err) {
    if (err instanceof UserError) return reply(err.code, { error: err.message });
    console.error('unit-api error:', body.action, err);
    return reply(500, { error: 'Something went wrong. Please try again.' });
  }
};

// Exposed for tests
exports._internal = { assignToSlot, makeToken, readToken };
