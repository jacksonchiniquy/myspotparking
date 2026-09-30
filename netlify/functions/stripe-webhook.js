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

  // 3. Create or find Supabase auth user
  // We use the admin API to create the user with a known password
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
    user_id: userId || null,
    email: tenant_email,
    name: tenant_name,
    unit_number,
    invite_code,
    status: 'active',
    billing_status: 'active',
    billing_interval: billing_interval || 'monthly',
    stripe_customer_id: session.customer,
    stripe_subscription_id: session.subscription || null,
    expires_at: expiresAt,
  });
  if (!Array.isArray(permitResult)) {
    console.error('Permit insert failed:', JSON.stringify(permitResult));
    throw new Error(`Permit insert failed: ${JSON.stringify(permitResult)}`);
  }
  const permit = permitResult[0];

  // 6. Look up property name for email
  const [property] = await sbSelect('properties', `id=eq.${property_id}&select=name,manager_email`);
  const propertyName = property?.name || 'your property';
  const managerEmail = property?.manager_email;

  // 7. Send welcome email to tenant
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

  // 8. Alert manager
  if (managerEmail) {
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
  }

  console.log(`Permit created for ${tenant_email} at ${propertyName} Unit ${unit_number}`);
}

async function handleInvoicePaid(invoice) {
  const customerId = invoice.customer;
  const subscriptionId = invoice.subscription;
  if (!subscriptionId) return;

  // Keep permit active + update period end
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

  // Mark permit past_due
  await sbUpdate('permits', { billing_status: 'past_due' }, `stripe_subscription_id=eq.${subscriptionId}`);

  // Get permit + tenant info
  const permits = await sbSelect('permits', `stripe_subscription_id=eq.${subscriptionId}&select=*`);
  const permit = permits?.[0];
  if (!permit) return;

  const [property] = await sbSelect('properties', `id=eq.${permit.property_id}&select=name,manager_email`);
  const propertyName = property?.name || 'your property';
  const portalUrl = await getBillingPortalUrl(customerId);

  // Email tenant
  if (permit.email) {
    await send({
      type: 'payment_failed',
      to: permit.email,
      data: {
        name: permit.name || 'Resident',
        email: permit.email,
        propertyName,
        portalUrl,
      },
    });
  }

  // Alert manager
  if (property?.manager_email) {
    await send({
      type: 'manager_alert',
      to: property.manager_email,
      data: {
        eventType: 'payment_failed',
        tenantName: permit.name || permit.email,
        tenantEmail: permit.email,
        propertyName,
        unitNumber: permit.unit_number || '—',
      },
    });
  }
}

async function handleSubscriptionDeleted(subscription) {
  const subscriptionId = subscription.id;

  // Suspend permit
  await sbUpdate('permits', { billing_status: 'suspended', status: 'revoked' }, `stripe_subscription_id=eq.${subscriptionId}`);

  const permits = await sbSelect('permits', `stripe_subscription_id=eq.${subscriptionId}&select=*`);
  const permit = permits?.[0];
  if (!permit) return;

  const [property] = await sbSelect('properties', `id=eq.${permit.property_id}&select=name,manager_email`);
  const propertyName = property?.name || 'your property';

  // Email tenant
  if (permit.email) {
    await send({
      type: 'suspended',
      to: permit.email,
      data: {
        name: permit.name || 'Resident',
        propertyName,
        unitNumber: permit.unit_number || '—',
      },
    });
  }

  // Alert manager
  if (property?.manager_email) {
    await send({
      type: 'manager_alert',
      to: property.manager_email,
      data: {
        eventType: 'permit_suspended',
        tenantName: permit.name || permit.email,
        tenantEmail: permit.email,
        propertyName,
        unitNumber: permit.unit_number || '—',
      },
    });
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
