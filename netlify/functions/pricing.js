// pricing.js — discounts, price changes and promo codes (Manager portal)
//
// POST { action, ... }   Authorization: Bearer <manager or admin login>
// Owners and managers of the property (and LotHQ admins) only.
//
//   spot             { spotId, discount?, applyPrice?, email? }
//                    discount: null (remove) | { type:'pct'|'amount', value, duration:'forever'|'months'|'once', months?, note? }
//                    applyPrice: also move a card-paying tenant to the spot's current price
//   defaultRateInfo  { propertyId }  how many card-paying tenants use the default rate
//   applyDefaultRate { propertyId, email? }  move them to the property's current default rate
//   promoList        { propertyId }
//   promoSave        { propertyId, promo: { id?, code, kind, value, rateIds, maxUses, endsAt, oncePerDay } }
//   promoToggle      { propertyId, id, active }

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const team = require('./lib/team');
const { logActivity, userActor, money } = require('./lib/activity');
const pricing = require('./lib/spot-pricing');
const billing = require('./lib/spot-billing');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const q = encodeURIComponent;
const unitLabel = v => { const s = String(v ?? '').trim(); return /[a-z]/i.test(s) ? s : 'Unit ' + s; };
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function reply(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
class UserError extends Error { constructor(m, code = 400) { super(m); this.code = code; } }

async function sb(method, path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, ...(method === 'GET' ? {} : { Prefer: 'return=representation' }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    if (/discount_|promo_codes|pay_ahead|42P01|42703/.test(text)) throw new UserError('Discounts aren\'t switched on yet. LotHQ needs to finish one setup step first.', 503);
    if (/promo_codes_property_code|duplicate key/.test(text)) throw new UserError('This property already has a code with that name.');
    throw new Error(`Supabase ${method} ${path.split('?')[0]} ${res.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

async function auth(event, propertyId) {
  const jwt = String(event.headers?.authorization || event.headers?.Authorization || '').replace(/^Bearer\s+/i, '');
  if (!jwt) throw new UserError('Please sign in again.', 401);
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${jwt}` } });
  if (!res.ok) throw new UserError('Please sign in again.', 401);
  const user = await res.json();
  if (!UUID_RE.test(String(propertyId || ''))) throw new UserError('Property not found.', 404);
  const [property] = await sb('GET', `properties?id=eq.${propertyId}&select=*`);
  if (!property) throw new UserError('Property not found.', 404);
  const [me] = await sb('GET', `users?id=eq.${user.id}&select=id,role`);
  if (!team.atLeast(await team.roleOn(property, me), 'manager')) throw new UserError('Only the property\'s owners and managers can change prices and discounts.', 403);
  return { user, property, actor: await userActor(user.id) };
}

const liveSub = s => s && s.spot_paid && (s.paid_via || 'card') === 'card' && s.spot_subscription_id;

// The tenant's email for a unit (sign-up permit, or the unit row)
async function tenantEmail(spot) {
  try {
    const [p] = await sb('GET', `permits?property_id=eq.${spot.property_id}&unit_number=eq.${q(spot.unit_number)}&holder_email=not.is.null&select=holder_email&order=created_at.desc&limit=1`);
    if (p?.holder_email) return p.holder_email;
  } catch { /* ignore */ }
  const [u] = await sb('GET', `property_units?property_id=eq.${spot.property_id}&unit_number=eq.${q(spot.unit_number)}&tenant_email=not.is.null&select=tenant_email&limit=1`).catch(() => []);
  return u?.tenant_email || null;
}

async function emailTenant(to, property, heading, lines) {
  if (!to) return false;
  const { sendRaw, logoHeader } = require('./send-email');
  try {
    await sendRaw({
      to, subject: `${heading} — ${property.name || 'your parking'}`,
      html: `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 16px;color:#0f172a;background:#ffffff;">
  ${logoHeader('#2859a8')}
  <h2 style="margin:0 0 12px;">${esc(heading)}</h2>
  ${lines.map(l => `<p style="color:#475569;margin:0 0 10px;line-height:1.6;">${esc(l)}</p>`).join('')}
  <p style="color:#94a3b8;font-size:12px;margin-top:18px;">Questions? Contact your property manager.</p>
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;">
  <p style="color:#94a3b8;font-size:11px;text-align:center;">© ${new Date().getFullYear()} LotHQ · Provo, UT</p>
</body></html>`,
      text: `${heading}\n\n${lines.join('\n')}\n\nQuestions? Contact your property manager.`,
    });
    return true;
  } catch (e) { console.error('Tenant email failed:', e.message); return false; }
}

function cleanDiscount(d) {
  if (d === null) return null;
  const type = d.type === 'pct' ? 'pct' : d.type === 'amount' ? 'amount' : null;
  const value = Math.round(Number(d.value) * 100) / 100;
  if (!type || !(value > 0)) throw new UserError('Enter how much the discount is.');
  if (type === 'pct' && value > 100) throw new UserError('A percent discount can\'t be more than 100%.');
  const duration = ['forever', 'months', 'once'].includes(d.duration) ? d.duration : 'forever';
  const months = duration === 'months' ? Math.round(Number(d.months)) : null;
  if (duration === 'months' && !(months >= 1 && months <= 36)) throw new UserError('Enter how many months (1 to 36).');
  return { discount_type: type, discount_value: value, discount_duration: duration, discount_months: months,
    discount_note: typeof d.note === 'string' && d.note.trim() ? d.note.trim().slice(0, 200) : null };
}

const actions = {
  async spot(body, event) {
    if (!UUID_RE.test(String(body.spotId || ''))) throw new UserError('Spot not found.', 404);
    const [spot] = await sb('GET', `property_units?id=eq.${body.spotId}&select=*`);
    if (!spot) throw new UserError('Spot not found.', 404);
    const { property, actor } = await auth(event, spot.property_id);
    if (!('discount_type' in spot)) throw new UserError('Discounts aren\'t switched on yet. LotHQ needs to finish one setup step first.', 503);
    const where = `${unitLabel(spot.unit_number)} · ${spot.slot_label || 'Spot'}`;
    const out = { ok: true };
    let changedDiscount = false;

    if (body.discount !== undefined) {
      if (spot.billing_type !== 'monthly' && body.discount) throw new UserError('Discounts are only for paid spots.');
      const d = cleanDiscount(body.discount);
      const patch = d ? { ...d, discount_ends_at: null }
        : { discount_type: null, discount_value: null, discount_duration: null, discount_months: null, discount_note: null, discount_ends_at: null };
      const same = d ? ['discount_type', 'discount_value', 'discount_duration', 'discount_months'].every(k => String(spot[k] ?? '') === String(d[k] ?? '')) && pricing.discountActive(spot)
        : !spot.discount_type;
      if (!same) {
        Object.assign(spot, patch);
        await sb('PATCH', `property_units?id=eq.${spot.id}`, patch);
        changedDiscount = true;
        await logActivity({ ...actor, portal: 'manager', action: d ? 'billing.discount_set' : 'billing.discount_removed', propertyId: spot.property_id, target: where,
          summary: d ? `Gave ${where} ${pricing.discountLabel(spot)}${d.discount_note ? ` — "${d.discount_note}"` : ''}` : `Removed the discount on ${where}`,
          details: { spot_id: spot.id, ...d } });
      } else if (d && d.discount_note !== spot.discount_note) {
        await sb('PATCH', `property_units?id=eq.${spot.id}`, { discount_note: d.discount_note });
      }
    }

    if (liveSub(spot) && (changedDiscount || body.applyPrice)) {
      const r = await billing.syncSubscription(stripe, spot.spot_subscription_id, { applyPrice: !!body.applyPrice, changedSpotIds: changedDiscount ? [spot.id] : [] });
      out.live = r.ok;
      if (r.changedPrice) {
        out.priceFrom = r.oldCents; out.priceTo = r.newCents;
        await logActivity({ ...actor, portal: 'manager', action: 'billing.price_changed', propertyId: spot.property_id, target: where,
          summary: `Changed ${where}'s card billing from ${money(r.oldCents)} to ${money(r.newCents)} (from their next payment)`, details: { spot_id: spot.id, subscription: spot.spot_subscription_id } });
      }
      if (body.email) {
        const to = await tenantEmail(spot);
        const lines = [];
        if (r.changedPrice) lines.push(`Your parking price for ${where} is changing from ${money(r.oldCents)} to ${money(r.newCents)} per ${r.months === 12 ? 'year' : r.months === 3 ? '3 months' : 'month'}, starting with your next payment.`);
        if (changedDiscount && pricing.discountActive(spot)) lines.push(`Good news: ${where} now has ${pricing.discountLabel(spot)}. It comes off your card payments automatically.`);
        if (changedDiscount && !pricing.discountActive(spot)) lines.push(`The discount on ${where} has ended. Your next payment will be at the regular price.`);
        if (lines.length) out.emailed = await emailTenant(to, property, r.changedPrice ? 'Your parking price is changing' : 'Your parking discount', lines);
      }
    }
    const [fresh] = await sb('GET', `property_units?id=eq.${spot.id}&select=*`);
    out.spot = fresh;
    out.label = pricing.discountLabel(fresh);
    return out;
  },

  async defaultRateInfo(body, event) {
    const { property } = await auth(event, body.propertyId);
    const spots = await sb('GET', `property_units?property_id=eq.${property.id}&billing_type=eq.monthly&spot_paid=eq.true&spot_subscription_id=not.is.null&select=id,monthly_amount,paid_via,spot_subscription_id,unit_number`);
    const onDefault = spots.filter(s => (s.paid_via || 'card') === 'card' && !(Number(s.monthly_amount) > 0));
    return { tenants: new Set(onDefault.map(s => s.unit_number)).size, subscriptions: new Set(onDefault.map(s => s.spot_subscription_id)).size };
  },

  async applyDefaultRate(body, event) {
    const { property, actor } = await auth(event, body.propertyId);
    const spots = await sb('GET', `property_units?property_id=eq.${property.id}&billing_type=eq.monthly&spot_paid=eq.true&spot_subscription_id=not.is.null&select=*`);
    const subs = [...new Set(spots.filter(s => (s.paid_via || 'card') === 'card' && !(Number(s.monthly_amount) > 0)).map(s => s.spot_subscription_id))];
    let changed = 0, failed = 0, emailed = 0;
    for (const sub of subs) {
      try {
        const r = await billing.syncSubscription(stripe, sub, { applyPrice: true });
        if (!r.changedPrice) continue;
        changed++;
        if (body.email) {
          const s = spots.find(x => x.spot_subscription_id === sub);
          const per = r.months === 12 ? 'year' : r.months === 3 ? '3 months' : 'month';
          if (await emailTenant(await tenantEmail(s), property, 'Your parking price is changing',
            [`Your parking price at ${property.name || 'your property'} is changing from ${money(r.oldCents)} to ${money(r.newCents)} per ${per}, starting with your next payment.`])) emailed++;
        }
      } catch (e) { failed++; console.error('applyDefaultRate', sub, e.message); }
    }
    await logActivity({ ...actor, portal: 'manager', action: 'billing.default_rate_applied', propertyId: property.id,
      summary: `Moved ${changed} card-paying tenant${changed === 1 ? '' : 's'} to the default rate of $${property.monthly_rate}/mo (from their next payment)${failed ? `; ${failed} couldn't be changed` : ''}`,
      details: { changed, failed } });
    return { ok: true, changed, failed, emailed };
  },

  // ── Pay to Park promo codes ──
  async promoList(body, event) {
    const { property } = await auth(event, body.propertyId);
    return { promos: await sb('GET', `promo_codes?property_id=eq.${property.id}&select=*&order=created_at.desc`) };
  },

  async promoSave(body, event) {
    const { property, actor, user } = await auth(event, body.propertyId);
    const p = body.promo || {};
    const code = String(p.code || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 20);
    if (code.length < 3) throw new UserError('Codes need at least 3 letters or numbers.');
    const kind = ['pct', 'amount', 'free'].includes(p.kind) ? p.kind : null;
    if (!kind) throw new UserError('Pick a discount type.');
    const value = kind === 'free' ? null : Math.round(Number(p.value) * 100) / 100;
    if (kind !== 'free' && !(value > 0)) throw new UserError('Enter how much the code takes off.');
    if (kind === 'pct' && value > 100) throw new UserError('A percent can\'t be more than 100%.');
    const rateIds = Array.isArray(p.rateIds) && p.rateIds.length ? p.rateIds.map(String).slice(0, 20) : null;
    const maxUses = p.maxUses ? Math.max(1, Math.round(Number(p.maxUses))) : null;
    const endsAt = p.endsAt ? new Date(p.endsAt) : null;
    if (endsAt && isNaN(endsAt)) throw new UserError('That end date isn\'t valid.');
    const row = { code, kind, value, rate_ids: rateIds, max_uses: maxUses, ends_at: endsAt ? endsAt.toISOString() : null, once_per_day: !!p.oncePerDay };
    let saved;
    if (p.id) {
      if (!UUID_RE.test(String(p.id))) throw new UserError('Code not found.', 404);
      [saved] = await sb('PATCH', `promo_codes?id=eq.${p.id}&property_id=eq.${property.id}`, row);
      if (!saved) throw new UserError('Code not found.', 404);
    } else {
      [saved] = await sb('POST', 'promo_codes', { ...row, property_id: property.id, created_by: user.id });
    }
    const what = kind === 'free' ? 'free parking' : kind === 'pct' ? `${value}% off` : `${money(value * 100)} off`;
    await logActivity({ ...actor, portal: 'manager', action: p.id ? 'pay.promo_updated' : 'pay.promo_created', propertyId: property.id, target: code,
      summary: `${p.id ? 'Updated' : 'Created'} Pay to Park code ${code} (${what})`, details: row });
    return { ok: true, promo: saved };
  },

  async promoToggle(body, event) {
    const { property, actor } = await auth(event, body.propertyId);
    if (!UUID_RE.test(String(body.id || ''))) throw new UserError('Code not found.', 404);
    const [saved] = await sb('PATCH', `promo_codes?id=eq.${body.id}&property_id=eq.${property.id}`, { active: !!body.active });
    if (!saved) throw new UserError('Code not found.', 404);
    await logActivity({ ...actor, portal: 'manager', action: 'pay.promo_toggled', propertyId: property.id, target: saved.code,
      summary: `Turned Pay to Park code ${saved.code} ${body.active ? 'on' : 'off'}` });
    return { ok: true, promo: saved };
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
    console.error('pricing error:', body.action, err?.raw?.message || err.message, err);
    if (err?.type === 'StripeInvalidRequestError' && err.raw?.message) return reply(400, { error: 'Stripe said: ' + err.raw.message });
    return reply(500, { error: 'Something went wrong. Please try again.' });
  }
};
