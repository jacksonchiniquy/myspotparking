// parking-session-status.js — pay.html calls this when the driver returns from Stripe.
// Confirms the payment with Stripe, activates the session if the webhook hasn't yet,
// and returns only what the receipt screen needs.

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { sb, activateSession } = require('./lib/parking');

function reply(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed' });
  let sessionId;
  try { sessionId = String(JSON.parse(event.body || '{}').sessionId || ''); } catch { return reply(400, { error: 'Invalid request' }); }
  if (!/^cs_[A-Za-z0-9_]{10,200}$/.test(sessionId)) return reply(400, { error: 'Invalid session' });

  try {
    // Payments for properties with a payout account live in that Stripe account
    const [saved] = await sb('GET', `parking_sessions?stripe_session_id=eq.${encodeURIComponent(sessionId)}&select=stripe_account_id`).catch(() => []);
    const account = saved?.stripe_account_id || null;
    const checkout = await stripe.checkout.sessions.retrieve(sessionId, {}, account ? { stripeAccount: account } : undefined);
    if (checkout.metadata?.kind !== 'parking_session') return reply(404, { error: 'Session not found' });
    if (checkout.payment_status !== 'paid') return reply(200, { status: 'unpaid' });

    const row = await activateSession(checkout);
    if (!row) return reply(404, { error: 'Session not found' });
    const [property] = await sb('GET', `properties?id=eq.${row.property_id}&select=name`);
    return reply(200, {
      status: row.status, plate: row.plate, vehicle_desc: row.vehicle_desc, stall: row.stall || null, property_name: property?.name || '',
      duration_minutes: row.duration_minutes, started_at: row.started_at, expires_at: row.expires_at,
    });
  } catch (err) {
    console.error('parking-session-status error:', err);
    return reply(500, { error: 'Could not confirm your payment yet. Please refresh in a moment.' });
  }
};
