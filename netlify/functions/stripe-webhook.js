// stripe-webhook.js — handles all Stripe webhook events
// Events handled:
//   checkout.session.completed    → create permit, generate password, send welcome email
//   invoice.paid                  → keep permit active, send receipt
//   invoice.payment_failed        → warn tenant + manager
//   customer.subscription.deleted → suspend permit, notify manager

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { send } = require('./send-email');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY; // service role key for server-side writes
const SITE = process.env.SITE_URL || 'https://myspotparking.com';

// ── Supabase helpers ─────────────────────────────────────────
function sbHeaders() {
  return {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Prefer': 'return=representation',
  };
}

async function sbSelect(table, filters = '') {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filters}`, {
    headers: sbHeaders(),
  });
  return res.json();
}

async function sbInsert(table, data) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: sbHeaders(),
    body: JSON.stringify(data),
  });
  return res.json();
}

async function sbUpdate(table, data, filters) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filters}`, {
    method: 'PATCH',
    headers: sbHeaders(),
    body: JSON.stringify(data),
  });
  return res.json();
}

// ── Password generator ───────────────────────────────────────
function generatePassword(length = 10) {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let pass = '';
  for (let i = 0; i < length; i++) {
    pass += chars[Math.floor(Math.random() * chars.length)];
  }
  return pass;
}

// ── Stripe Customer Portal URL ───────────────────────────────
async function getBillingPortalUrl(customerId) {
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${SITE}/holder.html`,
    });
    return session.url;
  } catch {
    return `${SITE}/holder.html`;
  }
}

// ── Event handlers ───────────────────────────────────────────

async function handleCheckoutCompleted(session) {
  const meta = session.metadata || {};
  const {
    invite_code, property_id, unit_number,
    tenant_name, tenant_email, billing_interval,
  } = meta;

  if (!invite_code || !property_id) {
    console.log('Not a permit signup checkout — skipping');
    return;
  }

  // 1. Mark invite code as used
  await sbUpdate(
    'property_units',
    { invite_used: true, invite_used_at: new Date().toISOString(), tenant_email, tenant_name },
    `invite_code=eq.${invite_code}`
  );

  // 2. Generate password
  const password = generatePassword();
// Save password to property_units so unit.html login works
await sbUpdate(
  'property_units',
  { unit_password: password },
  `invite_code=eq.${invite_code}`
);
  // 3. Create or find Supabase auth user
  const authRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    },
    body: JSON.stringify({
      email: tenant_email,
      password,
      email_confirm: true,
      user_metadata: { name: tenant_name, role: 'holder' },
    }),
  });
  const authData = await authRes.json();
  const userId = authData.id;

  // 4. Insert into users table
  if (userId) {
    await sbInsert('users', {
      id: userId,
      email: tenant_email,
      name: tenant_name,
      role: 'holder',
      property_id,
    }).catch(() => {}); // ignore if already exists
  }

  // 5. Create permit
  const expiresAt = session.subscription
    ? null // subscription — no fixed expiry
    : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const permitResult = await sbInsert('permits', {
    property_id,
    holder_id: userId || null,
    holder_email: tenant_email,
    holder_name: tenant_name,
    unit_number,
    invite_code,
    status: 'active',
    billing_status: 'active',
    billing_interval: billing_interval || 'monthly',
    stripe_customer_id: session.customer,
    stripe_subscription_id: session.subscription || null,
    end_date: expiresAt,
    source: 'unit-self',
    plan: 'monthly',
    plate: '',
  });
  if (!Array.isArray(permitResult)) {
    console.error('Permit insert failed:', JSON.stringify(permitResult));
    throw new Error(`Permit insert failed: ${JSON.stringify(permitResult)}`);
  }
  const permit = permitResult[0];

  // 6. Look up property name for email
  const propertyResult = await sbSelect('properties', `id=eq.${property_id}&select=name,manager_email`);
  const property = Array.isArray(propertyResult) ? propertyResult[0] : null;
  const propertyName = property?.name || 'your property';
  const managerEmail = property?.manager_email;

  // 7. Send welcome email to tenant (non-fatal)
  try {
    await send({
      type: 'welcome',
      to: tenant_email,
      data: {
        name: tenant_name,
        email: tenant_email,
        password,
        propertyName,
        unitNumber: unit_number,
      },
    });
  } catch (emailErr) {
    console.error('Welcome email failed (non-fatal):', emailErr.message);
  }

  // 8. Alert manager (non-fatal)
  if (managerEmail) {
    try {
      await send({
        type: 'manager_alert',
        to: managerEmail,
        data: {
          eventType: 'new_signup',
          tenantName: tenant_name,
          tenantEmail: tenant_email,
          propertyName,
          unitNumber: unit_number,
        },
      });
    } catch (emailErr) {
      console.error('Manager alert email failed (non-fatal):', emailErr.message);
    }
  }

  console.log(`Permit created for ${tenant_email} at ${propertyName} Unit ${unit_number}`);
}

async function handleInvoicePaid(invoice) {
  const customerId = invoice.customer;
  const subscriptionId = invoice.subscription;
  if (!subscriptionId) return;

  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  await sbUpdate(
    'permits',
    {
      billing_status: 'active',
      current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
    },
    `stripe_subscription_id=eq.${subscriptionId}`
  );

  console.log(`Invoice paid for subscription ${subscriptionId}`);
}

async function handlePaymentFailed(invoice) {
  const subscriptionId = invoice.subscription;
  const customerId = invoice.customer;
  if (!subscriptionId) return;

  await sbUpdate('permits', { billing_status: 'past_due' }, `stripe_subscription_id=eq.${subscriptionId}`);

  const permits = await sbSelect('permits', `stripe_subscription_id=eq.${subscriptionId}&select=*`);
  const permit = permits?.[0];
  if (!permit) return;

  const propertyResult2 = await sbSelect('properties', `id=eq.${permit.property_id}&select=name,manager_email`);
  const property = Array.isArray(propertyResult2) ? propertyResult2[0] : null;
  const propertyName = property?.name || 'your property';
  const portalUrl = await getBillingPortalUrl(customerId);

  if (permit.holder_email) {
    try {
      await send({
        type: 'payment_failed',
        to: permit.holder_email,
        data: {
          name: permit.holder_name || 'Resident',
          email: permit.holder_email,
          propertyName,
          portalUrl,
        },
      });
    } catch (emailErr) {
      console.error('Payment failed email error (non-fatal):', emailErr.message);
    }
  }

  if (property?.manager_email) {
    try {
      await send({
        type: 'manager_alert',
        to: property.manager_email,
        data: {
          eventType: 'payment_failed',
          tenantName: permit.holder_name || permit.holder_email,
          tenantEmail: permit.holder_email,
          propertyName,
          unitNumber: permit.unit_number || '—',
        },
      });
    } catch (emailErr) {
      console.error('Manager alert email error (non-fatal):', emailErr.message);
    }
  }
}

async function handleSubscriptionDeleted(subscription) {
  const subscriptionId = subscription.id;

  await sbUpdate('permits', { billing_status: 'suspended', status: 'revoked' }, `stripe_subscription_id=eq.${subscriptionId}`);

  const permits = await sbSelect('permits', `stripe_subscription_id=eq.${subscriptionId}&select=*`);
  const permit = permits?.[0];
  if (!permit) return;

  const propertyResult3 = await sbSelect('properties', `id=eq.${permit.property_id}&select=name,manager_email`);
  const property = Array.isArray(propertyResult3) ? propertyResult3[0] : null;
  const propertyName = property?.name || 'your property';

  if (permit.holder_email) {
    try {
      await send({
        type: 'suspended',
        to: permit.holder_email,
        data: {
          name: permit.holder_name || 'Resident',
          propertyName,
          unitNumber: permit.unit_number || '—',
        },
      });
    } catch (emailErr) {
      console.error('Suspension email error (non-fatal):', emailErr.message);
    }
  }

  if (property?.manager_email) {
    try {
      await send({
        type: 'manager_alert',
        to: property.manager_email,
        data: {
          eventType: 'permit_suspended',
          tenantName: permit.holder_name || permit.holder_email,
          tenantEmail: permit.holder_email,
          propertyName,
          unitNumber: permit.unit_number || '—',
        },
      });
    } catch (emailErr) {
      console.error('Manager alert email error (non-fatal):', emailErr.message);
    }
  }
}

// ── Main handler ─────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const sig = event.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(event.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  try {
    switch (stripeEvent.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(stripeEvent.data.object);
        break;
      case 'invoice.paid':
        await handleInvoicePaid(stripeEvent.data.object);
        break;
      case 'invoice.payment_failed':
        await handlePaymentFailed(stripeEvent.data.object);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(stripeEvent.data.object);
        break;
      default:
        console.log(`Unhandled event type: ${stripeEvent.type}`);
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  } catch (err) {
    console.error('Webhook handler error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
