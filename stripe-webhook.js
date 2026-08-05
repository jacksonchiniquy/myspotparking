const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const SUPABASE_URL = 'https://ajadbfojccztiauxyxos.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFqYWRiZm9qY2N6dGlhdXh5eG9zIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY3OTU1NDcsImV4cCI6MjA5MjM3MTU0N30.dHMc-kGb0YFHnTfxnwGYfikmKZBLPzS5lfe6SyRsguU';

async function supabaseUpdate(table, data, filter) {
  const params = new URLSearchParams(filter);
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON,
      'Authorization': `Bearer ${SUPABASE_ANON}`,
    },
    body: JSON.stringify(data)
  });
  return res.json();
}

exports.handler = async (event) => {
  const sig = event.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(event.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  if (stripeEvent.type === 'checkout.session.completed') {
    const session = stripeEvent.data.object;
    const durationMinutes = parseInt(session.metadata.duration_minutes || '60');
    const expiresAt = new Date(session.created * 1000 + durationMinutes * 60 * 1000).toISOString();

    // Update session to active
    await supabaseUpdate(
      'parking_sessions',
      {
        status: 'active',
        stripe_payment_intent: session.payment_intent,
        started_at: new Date(session.created * 1000).toISOString(),
        expires_at: expiresAt
      },
      { stripe_session_id: `eq.${session.id}` }
    );

    console.log('Parking session confirmed:', session.metadata.plate, 'expires:', expiresAt);
  }

  if (stripeEvent.type === 'checkout.session.expired') {
    const session = stripeEvent.data.object;
    await supabaseUpdate(
      'parking_sessions',
      { status: 'cancelled' },
      { stripe_session_id: `eq.${session.id}` }
    );
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
