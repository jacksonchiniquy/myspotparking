// Adding a paid spot after sign-up (unit portal button, or the manager's
// emailed payment link). One small monthly Stripe subscription per spot, so
// cancelling it locks only that spot.

const crypto = require('crypto');
const { spotMonthlyCents } = require('./spot-pricing');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SITE = process.env.SITE_URL || 'https://myspotparking.com';
const LINK_DAYS = 30;

async function sbGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
  if (!res.ok) throw new Error(`Supabase GET ${path.split('?')[0]} ${res.status}: ${await res.text()}`);
  return res.json();
}
const q = encodeURIComponent;

// The unit's existing Stripe customer (from sign-up or an earlier added spot)
async function unitCustomer(propertyId, unitNumber) {
  const [permit] = await sbGet(`permits?property_id=eq.${q(propertyId)}&unit_number=eq.${q(unitNumber)}&stripe_customer_id=not.is.null&select=stripe_customer_id&order=created_at.desc&limit=1`);
  if (permit) return permit.stripe_customer_id;
  const [spot] = await sbGet(`property_units?property_id=eq.${q(propertyId)}&unit_number=eq.${q(unitNumber)}&stripe_customer_id=not.is.null&select=stripe_customer_id&limit=1`);
  return spot ? spot.stripe_customer_id : null;
}

// Why a spot can't be paid for right now, or '' if it can
function spotProblem(slot) {
  if (!slot) return 'This parking spot no longer exists.';
  if (slot.billing_type !== 'monthly') return 'This spot is free — no payment needed.';
  if (slot.spot_paid) return 'This spot is already paid for.';
  return '';
}

async function createSpotCheckout(stripe, { slot, property, email, successUrl, cancelUrl }) {
  const amount = spotMonthlyCents(slot, property);
  if (!(amount >= 50)) throw Object.assign(new Error('Pricing is not set up for this spot. Contact your property manager.'), { user: true });
  const customer = await unitCustomer(slot.property_id, slot.unit_number);
  const metadata = { kind: 'spot_addon', slot_id: slot.id, property_id: slot.property_id, unit_number: slot.unit_number };
  return stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    ...(customer ? { customer } : email ? { customer_email: email } : {}),
    line_items: [{
      price_data: {
        currency: 'usd', unit_amount: amount, recurring: { interval: 'month', interval_count: 1 },
        product_data: {
          name: `Parking Spot — ${property?.name || 'Your Property'}`,
          description: `Unit ${slot.unit_number} · ${slot.slot_label || 'Spot'} · monthly`.slice(0, 500),
        },
      },
      quantity: 1,
    }],
    metadata,
    subscription_data: { metadata },
    success_url: successUrl,
    cancel_url: cancelUrl,
  });
}

// Signed links for the payment email (valid 30 days, one spot)
const LINK_KEY = () => crypto.createHash('sha256').update('spot-pay:' + SUPABASE_KEY).digest();
function makePayLink(slotId) {
  const payload = Buffer.from(JSON.stringify({ s: slotId, exp: Date.now() + LINK_DAYS * 864e5 })).toString('base64url');
  const sig = crypto.createHmac('sha256', LINK_KEY()).update(payload).digest('base64url');
  return `${SITE}/.netlify/functions/pay-spot?t=${payload}.${sig}`;
}
function readPayLink(token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) return null;
  const expect = crypto.createHmac('sha256', LINK_KEY()).update(payload).digest('base64url');
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.exp > Date.now() ? data : { expired: true };
  } catch { return null; }
}

module.exports = { createSpotCheckout, unitCustomer, spotProblem, makePayLink, readPayLink, sbGet, SITE };
