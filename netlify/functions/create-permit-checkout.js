// create-permit-checkout.js — creates a Stripe Checkout Session for permit signup
// Called from signup.html after tenant fills in their info

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const SITE = process.env.SITE_URL || 'https://myspotparking.com';

// Billing interval → Stripe interval mapping
const INTERVALS = {
  monthly:   { interval: 'month', interval_count: 1 },
  quarterly: { interval: 'month', interval_count: 3 },
  yearly:    { interval: 'year',  interval_count: 1 },
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const {
      inviteCode,
      propertyId,
      propertyName,
      unitNumber,
      tenantName,
      tenantEmail,
      billingInterval,  // 'monthly' | 'quarterly' | 'yearly'
      amount,           // in cents, e.g. 5000 = $50.00
    } = JSON.parse(event.body);

    if (!inviteCode || !propertyId || !tenantEmail || !amount) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields' }) };
    }

    const intervalConfig = INTERVALS[billingInterval] || INTERVALS.monthly;

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: tenantEmail,
      line_items: [{
        price_data: {
          currency: 'usd',
          unit_amount: amount,
          recurring: intervalConfig,
          product_data: {
            name: `Parking Permit — ${propertyName}`,
            description: `Unit ${unitNumber} · ${billingInterval} billing`,
          },
        },
        quantity: 1,
      }],
      metadata: {
        invite_code: inviteCode,
        property_id: propertyId,
        unit_number: unitNumber,
        tenant_name: tenantName,
        tenant_email: tenantEmail,
        billing_interval: billingInterval,
      },
      success_url: `${SITE}/holder.html?signup=success`,
      cancel_url: `${SITE}/signup.html?invite=${inviteCode}&cancelled=true`,
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: session.url }),
    };

  } catch (err) {
    console.error('create-permit-checkout error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
