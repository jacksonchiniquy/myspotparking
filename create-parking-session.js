const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const SUPABASE_URL = 'https://ajadbfojccztiauxyxos.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFqYWRiZm9qY2N6dGlhdXh5eG9zIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY3OTU1NDcsImV4cCI6MjA5MjM3MTU0N30.dHMc-kGb0YFHnTfxnwGYfikmKZBLPzS5lfe6SyRsguU';

async function supabaseInsert(table, data) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON,
      'Authorization': `Bearer ${SUPABASE_ANON}`,
      'Prefer': 'return=representation'
    },
    body: JSON.stringify(data)
  });
  return res.json();
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const {
      propertyId, propertyName, plate, vehicleDesc,
      email, rateName, amount, durationMinutes,
      successUrl, cancelUrl
    } = JSON.parse(event.body);

    if (!propertyId || !plate || !amount || !durationMinutes) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields' }) };
    }

    const apiKey = process.env.STRIPE_SECRET_KEY;
    if (!apiKey) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Stripe not configured' }) };
    }

    // Create Stripe Checkout Session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'usd',
          unit_amount: amount,
          product_data: {
            name: `Parking — ${propertyName}`,
            description: `${rateName} · Plate: ${plate.toUpperCase()}${vehicleDesc ? ' · ' + vehicleDesc : ''}`,
          },
        },
        quantity: 1,
      }],
      customer_email: email || undefined,
      metadata: {
        property_id: propertyId,
        plate: plate.toUpperCase(),
        vehicle_desc: vehicleDesc || '',
        duration_minutes: String(durationMinutes),
        rate_name: rateName,
      },
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    // Pre-create the parking session record (will be confirmed by webhook or on return)
    const expiresAt = new Date(Date.now() + durationMinutes * 60 * 1000).toISOString();
    await supabaseInsert('parking_sessions', {
      property_id: propertyId,
      plate: plate.toUpperCase(),
      vehicle_desc: vehicleDesc || null,
      amount_paid: amount,
      duration_minutes: durationMinutes,
      expires_at: expiresAt,
      stripe_session_id: session.id,
      status: 'pending'
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: session.url, sessionId: session.id })
    };

  } catch (err) {
    console.error('Stripe error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};
