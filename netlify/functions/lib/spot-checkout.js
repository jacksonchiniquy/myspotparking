// Adding a paid spot after sign-up (unit portal button, or the manager's
// emailed payment link). One small monthly Stripe subscription per spot, so
// cancelling it locks only that spot.

const crypto = require('crypto');
const { spotMonthlyCents } = require('./spot-pricing');
const connect = require('./connect');

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

// The unit's existing Stripe customer (from sign-up or an earlier added spot).
// Returns { customer, account } — account is the Stripe account the customer
// lives in (null = LotHQ's own). Older rows without that column count as LotHQ's.
async function unitCustomerInfo(propertyId, unitNumber) {
  const pick = async (table, cols) => {
    try { return (await sbGet(`${table}?property_id=eq.${q(propertyId)}&unit_number=eq.${q(unitNumber)}&stripe_customer_id=not.is.null&select=${cols},stripe_account_id${table === 'permits' ? '&order=created_at.desc' : ''}&limit=1`))[0]; }
    catch { return (await sbGet(`${table}?property_id=eq.${q(propertyId)}&unit_number=eq.${q(unitNumber)}&stripe_customer_id=not.is.null&select=${cols}${table === 'permits' ? '&order=created_at.desc' : ''}&limit=1`))[0]; }
  };
  const row = (await pick('permits', 'stripe_customer_id')) || (await pick('property_units', 'stripe_customer_id'));
  return row ? { customer: row.stripe_customer_id, account: row.stripe_account_id || null } : { customer: null, account: null };
}
async function unitCustomer(propertyId, unitNumber) {
  return (await unitCustomerInfo(propertyId, unitNumber)).customer;
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
  const { account } = await connect.routeFor(property);
  const found = await unitCustomerInfo(slot.property_id, slot.unit_number);
  // Reuse the resident's saved card only if it's in the same Stripe account
  const customer = found.customer && found.account === account ? found.customer : null;
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
    subscription_data: { metadata, ...connect.subscriptionFeeParams(property, account, amount) },
    success_url: successUrl,
    cancel_url: cancelUrl,
  }, connect.opts(account));
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

module.exports = { createSpotCheckout, unitCustomer, unitCustomerInfo, spotProblem, makePayLink, readPayLink, sbGet, SITE };
