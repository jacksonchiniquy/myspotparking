// create-parking-session.js — starts a Pay to Park checkout (called by pay.html)
// The browser only says which property, plate and rate it wants.
// The PRICE and DURATION come from the property's saved rates on the server.
// The session is saved as 'pending' and becomes 'active' when Stripe confirms payment.

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { ratesFor, sb } = require('./lib/parking');

const SITE = process.env.SITE_URL || 'https://myspotparking.com';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function reply(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed' });
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return reply(400, { error: 'Invalid request' }); }

  const propertyId = String(body.propertyId || '');
  const plate = String(body.plate || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 10);
  const vehicleDesc = typeof body.vehicleDesc === 'string' ? body.vehicleDesc.trim().slice(0, 80) : '';
  const email = typeof body.email === 'string' && EMAIL_RE.test(body.email.trim()) ? body.email.trim().toLowerCase() : null;
  if (!UUID_RE.test(propertyId)) return reply(400, { error: 'Property not found.' });
  if (plate.replace(/-/g, '').length < 2) return reply(400, { error: 'Please enter your license plate.' });
  if (!process.env.STRIPE_SECRET_KEY) return reply(500, { error: 'Payments are not set up yet. Please contact the property manager.' });

  try {
    const [property] = await sb('GET', `properties?id=eq.${propertyId}&select=*`);
    if (!property) return reply(404, { error: 'Property not found.' });

    // Stall number: required, optional or not used, as the property is set up
    const stallMode = property.stall_mode || 'off';
    const stall = stallMode === 'off' ? '' : String(body.stall || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 12);
    if (stallMode === 'required' && !stall) return reply(400, { error: 'Please enter the stall number from the sign.' });

    const terms = require('./lib/terms');
    const termsErr = await terms.checkAccepted(property.id, 'pay', body.termsVersion);
    if (termsErr) return reply(400, { error: termsErr, terms: true });

    const rates = ratesFor(property);
    const rate = rates.find(r => r.id && r.id === body.rateId) || rates[Number(body.rateIndex)];
    const amount = Math.round(Number(rate && rate.amount));
    const minutes = Math.round(Number(rate && rate.minutes));
    if (!rate || !(amount >= 50) || !(minutes > 0)) {
      return reply(400, { error: 'That parking option is no longer available. Please refresh and try again.' });
    }

    const checkout = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: email || undefined,
      line_items: [{
        price_data: {
          currency: 'usd',
          unit_amount: amount,
          product_data: {
            name: `Parking — ${property.name}`,
            description: `${rate.name} · Plate: ${plate}${stall ? ' · Stall ' + stall : ''}${vehicleDesc ? ' · ' + vehicleDesc : ''}`,
          },
        },
        quantity: 1,
      }],
      metadata: { kind: 'parking_session', property_id: property.id, plate, stall, duration_minutes: String(minutes), rate_name: String(rate.name || '') },
      success_url: `${SITE}/pay.html?lot=${property.id}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE}/pay.html?lot=${property.id}${stall ? '&s=' + encodeURIComponent(stall) : ''}`,
    });

    await sb('POST', 'parking_sessions', {
      property_id: property.id, plate, vehicle_desc: vehicleDesc || null, email,
      ...(stall ? { stall } : {}),
      rate_name: rate.name || null, amount_paid: amount /* cents */, duration_minutes: minutes,
      stripe_session_id: checkout.id, status: 'pending',
      // Placeholder; replaced with the real times when payment is confirmed.
      // (Enforcement only counts sessions marked 'active'.)
      started_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + minutes * 60000).toISOString(),
    });

    await terms.recordAcceptance({ propertyId: property.id, placement: 'pay', version: body.termsVersion, plate,
      acceptedBy: email || 'Pay to Park visitor', event });

    return reply(200, { url: checkout.url });
  } catch (err) {
    console.error('create-parking-session error:', err && (err.raw?.message || err.message), err);
    return reply(500, { error: 'Something went wrong starting your payment. Please try again.' });
  }
};
