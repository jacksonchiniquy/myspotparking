// create-permit-checkout.js — creates a Stripe Checkout Session for permit signup
// Called from signup.html after the tenant fills in their info.
// The PRICE is worked out on the server from the paid spots the resident
// picked (each spot's own price) — the browser only sends which spots and
// which billing cycle.

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const SITE = process.env.SITE_URL || 'https://myspotparking.com';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const { CYCLES, cycleCents, spotMonthlyCents, unitSpots, chosenPaidSpots } = require('./lib/spot-pricing');

const STRIPE_INTERVALS = {
  monthly:   { interval: 'month', interval_count: 1 },
  quarterly: { interval: 'month', interval_count: 3 },
  yearly:    { interval: 'year',  interval_count: 1 },
};

function reply(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed' });

  try {
    const body = JSON.parse(event.body || '{}');
    const inviteCode = String(body.inviteCode || '').trim().toUpperCase();
    const tenantEmail = String(body.tenantEmail || '').trim().toLowerCase();
    const tenantName = String(body.tenantName || '').trim().slice(0, 120);
    const billingInterval = CYCLES[body.billingInterval] ? body.billingInterval : 'monthly';

    if (!/^[A-Z0-9-]{4,20}$/.test(inviteCode) || !EMAIL_RE.test(tenantEmail)) {
      return reply(400, { error: 'Missing required fields' });
    }

    // Look up the invite and its property on the server
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/property_units?invite_code=eq.${encodeURIComponent(inviteCode)}&select=*,properties(*)&limit=1`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
    );
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
    const [unit] = await res.json();
    if (!unit) return reply(400, { error: 'Invite code not found.' });
    if (unit.invite_used) return reply(400, { error: 'This invite code has already been used.' });
    const terms = require('./lib/terms');
    const termsErr = await terms.checkAccepted(unit.property_id, 'signup', body.termsVersion);
    if (termsErr) return reply(400, { error: termsErr, terms: true });

    // The paid spots the resident ticked, each at its own price
    const property = unit.properties || {};
    const spots = await unitSpots(unit);
    const chosen = chosenPaidSpots(spots, body.spotIds).slice(0, 10);
    if (!chosen.length) {
      return reply(400, { error: 'Pick at least one paid spot, or continue without paid spots.' });
    }
    const monthlyCents = chosen.reduce((t, s) => t + spotMonthlyCents(s, property), 0);
    if (chosen.some(s => !(spotMonthlyCents(s, property) > 0))) {
      return reply(400, { error: 'Pricing is not set up for this spot. Contact your property manager.' });
    }
    const amount = cycleCents(monthlyCents, billingInterval);
    if (!(amount >= 50)) return reply(400, { error: 'Pricing is not set up for this property. Contact your property manager.' });
    const spotNames = chosen.map(s => s.slot_label || 'Spot').join(', ');

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: tenantEmail,
      line_items: [{
        price_data: {
          currency: 'usd',
          unit_amount: amount,
          recurring: STRIPE_INTERVALS[billingInterval],
          product_data: {
            name: `Parking Permit — ${property.name || 'Your Property'}`,
            description: `Unit ${unit.unit_number} · ${spotNames} · ${billingInterval} billing`.slice(0, 500),
          },
        },
        quantity: 1,
      }],
      metadata: {
        invite_code: inviteCode,
        property_id: unit.property_id,
        unit_number: unit.unit_number,
        tenant_name: tenantName,
        tenant_email: tenantEmail,
        billing_interval: billingInterval,
        spot_ids: chosen.map(s => s.id).join(','),
      },
      success_url: `${SITE}/signup.html?signup=success`,
      cancel_url: `${SITE}/signup.html?invite=${encodeURIComponent(inviteCode)}&cancelled=true`,
    });

    await terms.recordAcceptance({ propertyId: unit.property_id, placement: 'signup', version: body.termsVersion,
      acceptedBy: `${tenantEmail} · Unit ${unit.unit_number}`, event });
    return reply(200, { url: session.url });
  } catch (err) {
    console.error('create-permit-checkout error:', err);
    return reply(500, { error: 'Could not start checkout. Please try again.' });
  }
};
