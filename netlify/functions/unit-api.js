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
//   guestSummary { token }                   guest pass types, what's left, recent passes
//   guestIssue   { token, typeId, plate?, state?, vehicle?, guestName? }  give a guest pass
//   guestCancel  { token, id }               cancel an unused code (pass comes back) or end a pass early

const crypto = require('crypto');
const { hashPassword, verifyPassword, isHashed, generatePassword } = require('./lib/unit-password');
const { send, sendRaw, logoHeader } = require('./send-email');
const { logActivity } = require('./lib/activity');
const { createSpotCheckout, unitCustomer, spotProblem, makePayLink } = require('./lib/spot-checkout');
const { spotMonthlyCents } = require('./lib/spot-pricing');
const stripe = () => require('stripe')(process.env.STRIPE_SECRET_KEY);
const SITE = process.env.SITE_URL || 'https://lothq.com';
const GP = require('./lib/guest-passes');

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

// "Maria Lopez · Unit 101" for the terms acceptance record
function unitWho(u) {
  const name = (u.slots || []).find(s => s.tenant_name)?.tenant_name || (u.slots || []).find(s => s.tenant_email)?.tenant_email || '';
  return `${name ? name + ' · ' : ''}Unit ${u.unitNumber}`;
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
  const [me] = await sb('GET', `users?id=eq.${userId}&select=*`);
  const [slot] = await sb('GET', `property_units?id=eq.${slotId}&select=property_id,unit_number`);
  if (!slot) throw new UserError('Slot not found.', 404);
  const [prop] = await sb('GET', `properties?id=eq.${slot.property_id}&select=manager_id`);
  if (me?.role !== 'admin' && !(me?.role === 'manager' && prop?.manager_id === userId)) throw new UserError('Not allowed.', 403);
  const slots = await getSlots(slot.property_id, slot.unit_number);
  return { propertyId: slot.property_id, unitNumber: slot.unit_number, slots, slot: slots.find(x => x.id === slotId), userId, me };
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

// Which spots stop being paid if this spot's card billing is cancelled
async function cancelSpotPlan(u) {
  const slot = u.slot;
  if (!slot?.spot_paid || (slot.paid_via || 'card') !== 'card') throw new UserError('This spot isn\'t paid by card.');
  let subscription = slot.spot_subscription_id || null;
  if (!subscription) {
    // Older sign-ups didn't record it: use the unit's sign-up plan
    const [p] = await sb('GET', `permits?property_id=eq.${q(u.propertyId)}&unit_number=eq.${q(u.unitNumber)}&stripe_subscription_id=not.is.null&select=stripe_subscription_id&order=created_at.desc&limit=1`);
    subscription = p?.stripe_subscription_id || null;
  }
  const spots = u.slots.filter(x => x.spot_paid && (x.paid_via || 'card') === 'card' &&
    (x.id === slot.id || (subscription && (x.spot_subscription_id === subscription || (!x.spot_subscription_id && !slot.spot_subscription_id)))));
  const total = spots.reduce((t, x) => t + (Number(x.monthly_amount) || 0), 0);
  return { subscription, spots: spots.map(x => ({ id: x.id, label: x.slot_label || 'Spot', amount: x.monthly_amount })), total, shared: spots.length > 1 };
}

// ── Actions ──────────────────────────────────────────────────
const actions = {
  async login({ propertyId, unitNumber, password }, event, ctx = {}) {
    unitNumber = String(unitNumber || '').trim();
    if (!UUID_RE.test(String(propertyId || '')) || !unitNumber || !password) throw new UserError('Enter your property, unit number and password.');
    const slots = await getSlots(propertyId, unitNumber);
    if (!slots.length) throw new UserError('Unit not found for this property. Contact your property manager.');
    const slot = passwordSlot(slots);
    if (!slot.unit_password) throw new UserError('No password set for this unit. Contact your property manager.');
    if (!verifyPassword(password, slot.unit_password)) throw new UserError('Incorrect password. Check with your property manager.');
    ctx.u = { propertyId, unitNumber, slots };
    let stored = slot.unit_password;
    if (!isHashed(stored)) {
      // Upgrade a legacy plain-text password to the scrambled form
      stored = hashPassword(password);
      await sb('PATCH', `property_units?property_id=eq.${q(propertyId)}&unit_number=eq.${q(unitNumber)}&unit_password=not.is.null`, { unit_password: stored });
    }
    return { token: makeToken(propertyId, unitNumber, stored), propertyName: await propertyName(propertyId), unitNumber };
  },

  async load({ token }, event, ctx = {}) {
    const u = ctx.u = await authUnit(token);
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
      terms: await require('./lib/terms').termsFor(u.propertyId, 'unit_vehicle'),
    };
  },

  async addVehicle({ token, vehicle, termsVersion }, event, ctx = {}) {
    const u = ctx.u = await authUnit(token);
    const terms = require('./lib/terms');
    const termsErr = await terms.checkAccepted(u.propertyId, 'unit_vehicle', termsVersion);
    if (termsErr) throw new UserError(termsErr);
    const fields = vehicleFields(vehicle || {});
    await sb('POST', 'unit_vehicles', { property_id: u.propertyId, unit_number: u.unitNumber, ...fields });
    await terms.recordAcceptance({ propertyId: u.propertyId, placement: 'unit_vehicle', version: termsVersion, plate: fields.plate,
      acceptedBy: unitWho(u), event });
    return { ok: true };
  },

  async editVehicle({ token, id, vehicle }, event, ctx = {}) {
    const u = ctx.u = await authUnit(token);
    if (!UUID_RE.test(String(id || ''))) throw new UserError('Vehicle not found.');
    const rows = await sb('PATCH', `unit_vehicles?id=eq.${id}&property_id=eq.${q(u.propertyId)}&unit_number=eq.${q(u.unitNumber)}`, vehicleFields(vehicle || {}));
    if (!rows?.length) throw new UserError('Vehicle not found.', 404);
    return { ok: true };
  },

  async deleteVehicle({ token, id }, event, ctx = {}) {
    const u = ctx.u = await authUnit(token);
    if (!UUID_RE.test(String(id || ''))) throw new UserError('Vehicle not found.');
    const rows = await sb('DELETE', `unit_vehicles?id=eq.${id}&property_id=eq.${q(u.propertyId)}&unit_number=eq.${q(u.unitNumber)}`);
    if (!rows?.length) throw new UserError('Vehicle not found.', 404);
    return { ok: true };
  },

  async assign({ token, slotId, vehicleId, termsVersion }, event, ctx = {}) {
    const u = ctx.u = await authUnit(token);
    const terms = require('./lib/terms');
    const termsErr = await terms.checkAccepted(u.propertyId, 'unit_vehicle', termsVersion);
    if (termsErr) throw new UserError(termsErr);
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
    await terms.recordAcceptance({ propertyId: u.propertyId, placement: 'unit_vehicle', version: termsVersion, plate: veh[0].plate,
      acceptedBy: unitWho(u), event });
    return { ok: true, plate: veh[0].plate };
  },

  async saveEmail({ token, email }, event, ctx = {}) {
    const u = ctx.u = await authUnit(token);
    email = String(email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new UserError('Enter a valid email address.');
    await sb('PATCH', `property_units?property_id=eq.${q(u.propertyId)}&unit_number=eq.${q(u.unitNumber)}`, { tenant_email: email });
    return { ok: true };
  },

  async changePassword({ token, password }, event, ctx = {}) {
    const u = ctx.u = await authUnit(token);
    if (typeof password !== 'string' || password.length < 6) throw new UserError('Password must be at least 6 characters.');
    const stored = hashPassword(password);
    await sb('PATCH', `property_units?property_id=eq.${q(u.propertyId)}&unit_number=eq.${q(u.unitNumber)}`, { unit_password: stored });
    // New token so this device stays signed in; other devices are signed out
    return { ok: true, token: makeToken(u.propertyId, u.unitNumber, stored) };
  },

  async forgot({ propertyId, unitNumber, email }, event, ctx = {}) {
    unitNumber = String(unitNumber || '').trim();
    email = String(email || '').trim().toLowerCase();
    if (!UUID_RE.test(String(propertyId || '')) || !unitNumber || !EMAIL_RE.test(email)) throw new UserError('Enter your property, unit number and email.');
    const slots = await getSlots(propertyId, unitNumber);
    if (!slots.length) throw new UserError('Unit not found for this property.');
    ctx.u = { propertyId, unitNumber, slots };
    const onFile = slots.find(s => s.tenant_email)?.tenant_email;
    if (!onFile) throw new UserError('No email address is on file for this unit. Contact your property manager.');
    if (onFile.toLowerCase() !== email) throw new UserError('That email does not match what we have on file for this unit.');
    const password = generatePassword();
    // Email first, so a failed email never leaves the resident locked out
    await send({
      type: 'passwordReset', to: onFile,
      data: { name: slots.find(s => s.tenant_name)?.tenant_name || 'Resident', password, propertyName: await propertyName(propertyId), unitNumber, propertyId },
    });
    await sb('PATCH', `property_units?property_id=eq.${q(propertyId)}&unit_number=eq.${q(unitNumber)}`, { unit_password: hashPassword(password) });
    return { ok: true, sentTo: onFile };
  },

  async managerAssign({ slotId, plate, desc }, event, ctx = {}) {
    const u = ctx.u = await authManagerForSlot(event, slotId);
    const vehicle = { ...vehicleFields({ plate }), desc: typeof desc === 'string' && desc.trim() ? desc.trim().slice(0, 120) : null };
    await assignToSlot({ ...u, slotId, vehicle, assignedBy: 'manager' });
    return { ok: true };
  },

  // ── Paid spots added after sign-up ─────────────────────────
  async addSpotCheckout({ token, slotId }, event, ctx = {}) {
    const u = ctx.u = await authUnit(token);
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

  async billingPortal({ token }, event, ctx = {}) {
    const u = ctx.u = await authUnit(token);
    const customer = await unitCustomer(u.propertyId, u.unitNumber);
    if (!customer) throw new UserError('There is no card billing on this unit yet.');
    const session = await stripe().billingPortal.sessions.create({ customer, return_url: `${SITE}/unit.html` });
    return { url: session.url };
  },

  async managerSendSpotLink({ slotId, email }, event, ctx = {}) {
    const u = ctx.u = await authManagerForSlot(event, slotId);
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
  <p style="color:#94a3b8;font-size:11px;text-align:center;">© ${new Date().getFullYear()} LotHQ</p>
</body></html>`,
      text: `${spot} has been added to Unit ${u.unitNumber} at ${property.name || 'your property'} (${price}).\n\nPay and add the spot: ${link}\n\nBilled monthly by card. This link works for 30 days.`,
    });
    if (!u.slots.some(x => x.tenant_email)) {
      await sb('PATCH', `property_units?property_id=eq.${q(u.propertyId)}&unit_number=eq.${q(u.unitNumber)}`, { tenant_email: to });
    }
    return { ok: true, sentTo: to };
  },

  async managerMarkPaid({ slotId }, event, ctx = {}) {
    const u = ctx.u = await authManagerForSlot(event, slotId);
    if (!(await propertyRow(u.propertyId)).outside_billing) {
      throw new UserError('Outside billing isn\'t turned on for this property. Contact LotHQ to set it up.', 403);
    }
    const problem = spotProblem(u.slot);
    if (problem) throw new UserError(problem);
    await sb('PATCH', `property_units?id=eq.${u.slot.id}`, { spot_paid: true, paid_via: 'manual' });
    return { ok: true };
  },

  async managerMarkUnpaid({ slotId }, event, ctx = {}) {
    const u = ctx.u = await authManagerForSlot(event, slotId);
    if (!u.slot?.spot_paid) throw new UserError('This spot isn\'t marked paid.');
    if (u.slot.paid_via !== 'manual') {
      throw new UserError('This spot is paid by card. The resident can cancel it from Manage Billing in their unit portal.');
    }
    await sb('PATCH', `property_units?id=eq.${u.slot.id}`, { spot_paid: false, paid_via: null });
    return { ok: true };
  },

  // ── Tenant move-out (turnover) ─────────────────────────────
  async managerMoveOutPreview({ slotId }, event, ctx = {}) {
    const u = ctx.u = await authManagerForSlot(event, slotId);
    const { _subscriptions, vehicles, ...summary } = await moveOutSummary(u);
    return summary;
  },

  async managerMoveOut({ slotId }, event, ctx = {}) {
    const u = ctx.u = await authManagerForSlot(event, slotId);
    const sum = await moveOutSummary(u);
    ctx.u.moveOut = { tenantName: sum.tenantName, tenantEmail: sum.tenantEmail, plates: sum.plates, cardBilling: sum.cardBilling, paidSpots: sum.paidSpots };
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

  // ── Cancel one card-paid spot (tenant stays) ───────────────
  async managerCancelSpotPreview({ slotId }, event, ctx = {}) {
    const u = await authManagerForSlot(event, slotId);
    return cancelSpotPlan(u);
  },

  async managerCancelSpot({ slotId }, event, ctx = {}) {
    const u = ctx.u = await authManagerForSlot(event, slotId);
    const plan = await cancelSpotPlan(u);
    ctx.u.cancelPlan = plan;
    if (plan.subscription) {
      try {
        const st = stripe();
        await st.subscriptions.update(plan.subscription, { metadata: { manager_cancelled: '1' } });
        await st.subscriptions.cancel(plan.subscription);
      } catch (e) {
        if (!/No such subscription|canceled/i.test(e.message || '')) {
          console.error('Cancel spot failed', plan.subscription, e.message);
          throw new UserError('Stripe couldn\'t cancel this billing right now, so nothing was changed. Please try again.', 502);
        }
      }
      // If this was the sign-up plan, the tenant keeps their permit; only the billing ends
      await sb('PATCH', `permits?stripe_subscription_id=eq.${q(plan.subscription)}`, { billing_status: 'free' });
    }
    const ids = plan.spots.map(x => x.id);
    await sb('PATCH', `property_units?id=in.(${ids.join(',')})`, { spot_paid: false, paid_via: null, spot_subscription_id: null });
    return { ok: true, spots: plan.spots.map(x => x.label) };
  },

  async managerVoid({ slotId }, event, ctx = {}) {
    const u = ctx.u = await authManagerForSlot(event, slotId);
    const ups = await sb('PATCH', `unit_permits?unit_slot_id=eq.${slotId}&void_at=is.null`, { void_at: new Date().toISOString() });
    // The plate that was in this spot should no longer show as valid to enforcement
    const ids = (ups || []).map(up => up.permit_id).filter(Boolean);
    if (ids.length) await sb('PATCH', `permits?id=in.(${ids.join(',')})&property_id=eq.${q(u.propertyId)}`, { status: 'revoked' });
    return { ok: true };
  },

  // ── Guest passes ──────────────────────────────────────────
  async guestSummary({ token }, event, ctx = {}) {
    const u = ctx.u = await authUnit(token);
    const g = await guestContext(u);
    if (!g.enabled) return { enabled: false };
    return {
      enabled: true, word: g.word, propertyName: g.property.name, extrasEnabled: !!g.rules.extras_enabled,
      types: g.types.map(t => typeSummary(t, g.passes)),
      recent: g.passes.slice(0, 15).map(p => passView(p, g)),
    };
  },
  async guestIssue({ token, typeId, plate, state, vehicle, guestName }, event, ctx = {}) {
    const u = ctx.u = await authUnit(token);
    const g = await guestContext(u);
    if (!g.enabled) throw new UserError('Guest passes are not turned on for this property.');
    const type = g.types.find(t => t.id === typeId);
    if (!type) throw new UserError('That pass type is no longer offered. Refresh and try again.');
    if (type.needs_approval || type.length_kind === 'dates') throw new UserError('This pass needs manager approval. Use "Request an extended stay".');
    const sum = typeSummary(type, g.passes);
    if (sum.left !== null && sum.left <= 0) throw new UserError(`No ${type.name} left right now. Yours refill ${sum.refills}.`);
    const now = new Date();
    const tenant = (u.slots || []).find(x => x.tenant_name || x.tenant_email) || {};
    const row = {
      property_id: u.propertyId, pass_type_id: type.id, unit_number: u.unitNumber,
      issued_by_name: tenant.tenant_name || tenant.tenant_email || null,
      guest_name: typeof guestName === 'string' && guestName.trim() ? guestName.trim().slice(0, 60) : null,
    };
    const p = GP.normPlate(plate);
    if (p) {
      await checkPlateLimit(g, p, now);
      const w = GP.passWindow(type, now);
      Object.assign(row, { status: 'active', guest_plate: p, guest_state: cleanState(state), guest_vehicle: cleanText(vehicle, 60),
        starts_at: w.starts.toISOString(), ends_at: w.ends.toISOString(), activated_at: now.toISOString() });
    } else {
      const hours = Number(g.rules.code_hours) || 48;
      Object.assign(row, { status: 'issued', code_expires_at: new Date(now.getTime() + hours * 3600e3).toISOString() });
    }
    let saved;
    for (let i = 0; i < 5 && !saved; i++) {
      if (!p) row.code = GP.newCode();
      try { [saved] = await sb('POST', 'guest_passes', row); }
      catch (e) { if (!/guest_passes_code_key|duplicate key/.test(e.message) || p) throw e; }
    }
    u.guest = { type: type.name, plate: p || null, code: saved.code || null };
    const view = passView(saved, g);
    return { pass: view, link: saved.code ? `${SITE}/guest?c=${encodeURIComponent(saved.code)}` : null };
  },
  async guestCancel({ token, id }, event, ctx = {}) {
    const u = ctx.u = await authUnit(token);
    if (!UUID_RE.test(String(id || ''))) throw new UserError('Pass not found.');
    const [g] = await sb('GET', `guest_passes?id=eq.${id}&property_id=eq.${q(u.propertyId)}&unit_number=eq.${q(u.unitNumber)}&select=*`);
    if (!g) throw new UserError('Pass not found.');
    const now = new Date().toISOString();
    if (g.status === 'issued') {
      await sb('PATCH', `guest_passes?id=eq.${id}&status=eq.issued`, { status: 'cancelled', cancelled_at: now });
      u.guest = { how: 'cancelled', code: g.code };
      return { ok: true, refunded: true };
    }
    if (g.status === 'active' && new Date(g.ends_at) > new Date()) {
      await sb('PATCH', `guest_passes?id=eq.${id}`, { status: 'ended', ends_at: now, cancelled_at: now });
      u.guest = { how: 'ended', plate: g.guest_plate };
      return { ok: true, refunded: false };
    }
    throw new UserError('This pass has already ended.');
  },
};


// ── Guest pass helpers ──────────────────────────────────────
const cleanState = s => (typeof s === 'string' ? s.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2) : '') || null;
const cleanText = (s, n) => (typeof s === 'string' && s.trim() ? s.trim().slice(0, n) : null);
async function guestContext(u) {
  let property;
  try { [property] = await sb('GET', `properties?id=eq.${q(u.propertyId)}&select=name,space_word,guest_passes_enabled,guest_rules`); }
  catch (e) { return { enabled: false }; }  // database not updated for guest passes yet
  if (!property || !property.guest_passes_enabled) return { enabled: false };
  const types = await sb('GET', `guest_pass_types?property_id=eq.${q(u.propertyId)}&active=eq.true&select=*&order=sort`);
  const since = new Date(Date.now() - 400 * 864e5).toISOString();
  const passes = await sb('GET', `guest_passes?property_id=eq.${q(u.propertyId)}&unit_number=eq.${q(u.unitNumber)}&created_at=gte.${since}&select=*&order=created_at.desc&limit=500`);
  return { enabled: true, property, types, passes, rules: property.guest_rules || {}, word: (property.space_word || 'Unit').trim() || 'Unit', propertyId: u.propertyId };
}
function typeSummary(t, passes) {
  const now = new Date();
  const base = { id: t.id, name: t.name, kind: t.length_kind, describe: GP.describeType(t), needsApproval: !!t.needs_approval,
    extraPrice: t.extra_price_cents ?? null };
  if (t.allowance === null || t.allowance === undefined) return { ...base, allowance: null, used: null, left: null, refills: null };
  const period = GP.allowancePeriod(t.reset_period, now);
  const used = passes.filter(p => p.pass_type_id === t.id && new Date(p.created_at) >= period.start && GP.countsAgainstAllowance(p, now)).length;
  return { ...base, allowance: t.allowance, used, left: Math.max(0, t.allowance - used), refills: GP.fmtDay(period.next), reset: t.reset_period };
}
function passView(p, g) {
  const now = new Date();
  const type = (g.types || []).find(t => t.id === p.pass_type_id);
  let state = p.status;
  if (p.status === 'issued' && p.code_expires_at && new Date(p.code_expires_at) <= now) state = 'expired';
  if (p.status === 'active' && p.ends_at && new Date(p.ends_at) <= now) state = 'done';
  if (p.status === 'active' && p.starts_at && new Date(p.starts_at) > now) state = 'upcoming';
  return { id: p.id, type: type ? type.name : 'Guest pass', state, code: state === 'issued' ? p.code : null,
    codeExpires: p.code_expires_at ? GP.fmtWhen(p.code_expires_at) : null,
    plate: p.guest_plate || null, guestName: p.guest_name || null,
    starts: p.starts_at ? GP.fmtWhen(p.starts_at) : null, ends: p.ends_at ? GP.fmtWhen(p.ends_at) : null,
    created: GP.fmtWhen(p.created_at) };
}
// Same plate can only get so many guest passes per month at a property
async function checkPlateLimit(g, plate, now) {
  const limit = g.rules.plate_month_limit;
  if (limit === null || limit === undefined || limit === '') return;
  const since = GP.monthStart(now).toISOString();
  const rows = await sb('GET', `guest_passes?property_id=eq.${q(g.propertyId)}&guest_plate=eq.${q(plate)}&activated_at=gte.${since}&status=in.(active,ended)&select=id`);
  if (rows.length >= Number(limit)) {
    await logActivity({ actorRole: 'system', portal: 'unit', action: 'guest.plate_limit', propertyId: g.propertyId, target: plate,
      summary: `Guest pass refused: ${plate} already had ${rows.length} guest pass${rows.length === 1 ? '' : 'es'} this month (limit ${limit})` }).catch(() => {});
    throw new UserError(`This vehicle has reached this property's guest pass limit for the month (${limit}). Please contact the property manager.`);
  }
}

// ── Activity log entries for unit / manager actions ─────────
const slotName = (u, id) => (u?.slots || []).find(x => x.id === id)?.slot_label || 'a spot';
const LOG = {
  login:          (b, r, u) => ['auth.sign_in', 'Signed in to the unit portal'],
  addVehicle:     (b, r, u) => ['unit.vehicle_added', `Added vehicle ${String(b.vehicle?.plate || '').toUpperCase()}`, b.vehicle],
  editVehicle:    (b, r, u) => ['unit.vehicle_edited', `Edited vehicle ${String(b.vehicle?.plate || '').toUpperCase()}`, b.vehicle],
  deleteVehicle:  (b, r, u) => ['unit.vehicle_removed', 'Removed a vehicle'],
  assign:         (b, r, u) => ['unit.vehicle_assigned', `Put ${r.plate} in ${slotName(u, b.slotId)}`],
  saveEmail:      (b, r, u) => ['unit.email_changed', `Changed unit email to ${String(b.email || '').trim().toLowerCase()}`],
  changePassword: (b, r, u) => ['unit.password_changed', 'Changed the unit password'],
  forgot:         (b, r, u) => ['unit.password_reset', `Password reset emailed to ${r.sentTo}`],
  managerAssign:  (b, r, u) => ['unit.vehicle_assigned', `Put ${String(b.plate || '').toUpperCase()} in ${slotName(u, b.slotId)}`],
  managerVoid:    (b, r, u) => ['unit.vehicle_voided', `Cleared the car from ${slotName(u, b.slotId)}`],
  managerSendSpotLink: (b, r, u) => ['billing.payment_link_sent', `Sent a payment link for ${slotName(u, b.slotId)} to ${r.sentTo}`],
  managerMarkPaid:   (b, r, u) => ['billing.marked_paid', `Marked ${slotName(u, b.slotId)} as paid outside the app`],
  managerMarkUnpaid: (b, r, u) => ['billing.marked_unpaid', `Marked ${slotName(u, b.slotId)} as not paid`],
  managerCancelSpot: (b, r, u) => ['billing.spot_cancelled', `Cancelled card billing for ${(r.spots || []).join(', ')}`, { subscription: u?.cancelPlan?.subscription || null }],
  guestIssue:  (b, r, u) => ['guest.issued', u?.guest?.plate ? `Gave a ${u.guest.type} to ${u.guest.plate}` : `Created a ${u?.guest?.type || 'guest pass'} code ${u?.guest?.code || ''}`],
  guestCancel: (b, r, u) => ['guest.cancelled', u?.guest?.how === 'ended' ? `Ended the guest pass for ${u.guest.plate} early` : `Cancelled unused guest code ${u?.guest?.code || ''}`],
  managerMoveOut:    (b, r, u) => ['unit.moved_out', `Moved out ${u?.moveOut?.tenantName || u?.moveOut?.tenantEmail || 'the tenant'}`
    + (u?.moveOut?.plates?.length ? ` · voided ${u.moveOut.plates.join(', ')}` : '')
    + (u?.moveOut?.cardBilling ? ` · cancelled ${u.moveOut.cardBilling} card subscription${u.moveOut.cardBilling === 1 ? '' : 's'}` : '')
    + (r.inviteCode ? ` · new invite code ${r.inviteCode}` : ''), u?.moveOut],
};
async function logUnitAction(body, result, ctx) {
  const make = LOG[body.action];
  const u = ctx.u;
  if (!make || !u) return;
  const [action, summary, details] = make(body, result || {}, u);
  const isManager = body.action.startsWith('manager');
  const tenant = (u.slots || []).find(x => x.tenant_name || x.tenant_email) || {};
  await logActivity({
    actorId: isManager ? u.userId : null,
    actorName: isManager ? (u.me?.full_name || u.me?.name || u.me?.email) : (tenant.tenant_name || tenant.tenant_email || `Unit ${u.unitNumber} resident`),
    actorRole: isManager ? (u.me?.role || 'manager') : 'unit',
    portal: isManager ? 'manager' : 'unit',
    action, summary, propertyId: u.propertyId, target: `Unit ${u.unitNumber}`,
    details: details && typeof details === 'object' ? details : {},
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed' });
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return reply(400, { error: 'Invalid request' }); }
  const fn = actions[body.action];
  if (!fn) return reply(400, { error: 'Unknown action' });
  try {
    const ctx = {};
    const result = await fn(body, event, ctx);
    await logUnitAction(body, result, ctx);
    return reply(200, result);
  } catch (err) {
    if (err instanceof UserError) return reply(err.code, { error: err.message });
    console.error('unit-api error:', body.action, err);
    return reply(500, { error: 'Something went wrong. Please try again.' });
  }
};

// Exposed for tests
exports._internal = { assignToSlot, makeToken, readToken };
