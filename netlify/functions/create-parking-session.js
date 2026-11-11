// create-parking-session.js — starts a Pay to Park checkout (called by pay.html)
// The browser only says which property, plate and rate it wants.
// The PRICE and DURATION come from the property's saved rates on the server.
// The session is saved as 'pending' and becomes 'active' when Stripe confirms payment.

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { ratesFor, sb, insertSession } = require('./lib/parking');
const I = require('./lib/i18n');
const connect = require('./lib/connect');

const SITE = process.env.SITE_URL || 'https://lothq.com';
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
  const lang = I.pick(body.lang);
  const plate = String(body.plate || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 10);
  const vehicleDesc = typeof body.vehicleDesc === 'string' ? body.vehicleDesc.trim().slice(0, 80) : '';
  const email = typeof body.email === 'string' && EMAIL_RE.test(body.email.trim()) ? body.email.trim().toLowerCase() : null;
  if (!UUID_RE.test(propertyId)) return reply(400, { error: 'Property not found.' });
  if (plate.replace(/-/g, '').length < 2) return reply(400, { error: 'Please enter your license plate.' });
  if (!process.env.STRIPE_SECRET_KEY) return reply(500, { error: 'Payments are not set up yet. Please contact the property manager.' });

  try {
    const [property] = await sb('GET', `properties?id=eq.${propertyId}&select=*`);
    if (!property) return reply(404, { error: 'Property not found.' });
    if (!require('./lib/features').on(property, 'pay_to_park')) return reply(410, { error: 'Pay to Park isn\'t offered at this property.' });

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

    // Promo code (if the driver typed one)
    let promo = null, price = amount;
    if (body.promo) {
      const P = require('./lib/promo');
      promo = await P.findPromo(property.id, body.promo);
      const problem = await P.promoProblem(promo, rate, plate, property.timezone || undefined);
      if (problem) return reply(400, { error: problem, promo: true });
      price = P.priceWith(promo, amount);
    }

    // Free with a code: no card needed, parking starts now
    if (promo && price === 0) {
      const P = require('./lib/promo');
      if (!(await P.useIt(promo.id))) return reply(400, { error: 'That code has been used up.', promo: true });
      const start = new Date();
      const [row] = await insertSession({
        ...(lang !== 'en' ? { lang } : {}),
        property_id: property.id, plate, vehicle_desc: vehicleDesc || null, email,
        ...(stall ? { stall } : {}),
        rate_name: rate.name || null, amount_paid: 0, original_cents: amount, promo_code: promo.code, duration_minutes: minutes,
        status: 'active', started_at: start.toISOString(), expires_at: new Date(start.getTime() + minutes * 60000).toISOString(),
      });
      await terms.recordAcceptance({ propertyId: property.id, placement: 'pay', version: body.termsVersion, plate,
        acceptedBy: email || 'Pay to Park visitor', event });
      if (email) { try { await require('./lib/parking').sendReceipt(row, email); } catch (e) { console.error('Free parking receipt failed:', e.message); } }
      await require('./lib/activity').logActivity({ actorName: email || 'Pay to Park driver', actorRole: 'driver', portal: 'pay',
        action: 'pay.session_free', propertyId: property.id, target: plate,
        summary: `Parked ${plate} free with code ${promo.code}${rate.name ? ' · ' + rate.name : ''}`, details: { promo: promo.code, minutes } });
      return reply(200, { free: true, session: { status: 'active', plate, vehicle_desc: vehicleDesc || null, stall: stall || null, property_name: property.name || '',
        duration_minutes: minutes, started_at: row.started_at, expires_at: row.expires_at } });
    }

    // Where the money goes: the property's payout account (LotHQ keeps its fee), or LotHQ's own
    const { account } = await connect.routeFor(property);
    const lothqFee = account ? connect.feeCents(property, price) : null;

    const checkout = await stripe.checkout.sessions.create({
      mode: 'payment',
      locale: I.stripeLocale(lang),
      ...connect.paymentFeeParams(property, account, price),
      payment_method_types: ['card'],
      customer_email: email || undefined,
      line_items: [{
        price_data: {
          currency: 'usd',
          unit_amount: price,
          product_data: {
            name: `Parking — ${property.name}`,
            description: `${rate.name} · Plate: ${plate}${stall ? ' · Stall ' + stall : ''}${vehicleDesc ? ' · ' + vehicleDesc : ''}${promo ? ` · Code ${promo.code} (was $${(amount / 100).toFixed(2)})` : ''}`,
          },
        },
        quantity: 1,
      }],
      metadata: { kind: 'parking_session', property_id: property.id, plate, stall, duration_minutes: String(minutes), rate_name: String(rate.name || ''), ...(promo ? { promo_code: promo.code } : {}) },
      success_url: `${SITE}/pay.html?lot=${property.id}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE}/pay.html?lot=${property.id}${stall ? '&s=' + encodeURIComponent(stall) : ''}`,
    }, connect.opts(account));

    await insertSession({
      ...(lang !== 'en' ? { lang } : {}),
      property_id: property.id, plate, vehicle_desc: vehicleDesc || null, email,
      ...(stall ? { stall } : {}),
      rate_name: rate.name || null, amount_paid: price /* cents */, duration_minutes: minutes,
      ...(promo ? { promo_code: promo.code, original_cents: amount } : {}),
      stripe_session_id: checkout.id, status: 'pending',
      ...(account ? { stripe_account_id: account, lothq_fee_cents: lothqFee } : {}),
      // Placeholder; replaced with the real times when payment is confirmed.
      // (Enforcement only counts sessions marked 'active'.)
      started_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + minutes * 60000).toISOString(),
    });

    await terms.recordAcceptance({ propertyId: property.id, placement: 'pay', version: body.termsVersion, plate,
      acceptedBy: email || 'Pay to Park visitor', event });

    return reply(200, { url: checkout.url });
  } catch (err) {
    if (err instanceof connect.PaymentsPaused) return reply(400, { error: err.message });
    console.error('create-parking-session error:', err && (err.raw?.message || err.message), err);
    return reply(500, { error: 'Something went wrong starting your payment. Please try again.' });
  }
};
