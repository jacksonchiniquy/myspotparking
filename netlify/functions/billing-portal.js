// billing-portal.js — opens the Stripe billing page for the LOGGED-IN resident.
// Called from holder.html "Manage Billing". The resident's login is checked
// and their own Stripe customer is looked up on the server, so nobody can
// open someone else's billing page with a customer number.

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const SITE = process.env.SITE_URL || 'https://lothq.com';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

function reply(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed' });

  try {
    const jwt = String(event.headers?.authorization || event.headers?.Authorization || '').replace(/^Bearer\s+/i, '');
    if (!jwt) return reply(401, { error: 'Please sign in again.' });
    const who = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${jwt}` } });
    if (!who.ok) return reply(401, { error: 'Please sign in again.' });
    const { id: userId, email } = await who.json();

    // The resident's own permits that have Stripe billing (newest first)
    const or = `(holder_id.eq.${userId}${email ? `,holder_email.eq.${encodeURIComponent(String(email).toLowerCase())}` : ''})`;
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/permits?or=${or}&stripe_customer_id=not.is.null&select=stripe_customer_id,created_at&order=created_at.desc&limit=1`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
    );
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
    const [permit] = await res.json();
    if (!permit) return reply(404, { error: 'No billing info found. Contact your property manager.' });

    const session = await stripe.billingPortal.sessions.create({
      customer: permit.stripe_customer_id,
      return_url: `${SITE}/holder.html`,
    });
    return reply(200, { url: session.url });
  } catch (err) {
    console.error('billing-portal error:', err);
    return reply(500, { error: 'Could not open billing. Please try again.' });
  }
};
