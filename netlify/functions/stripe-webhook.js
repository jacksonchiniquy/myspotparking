// stripe-webhook.js — handles all Stripe webhook events
// Events handled:
//   checkout.session.completed    → create permit, generate password, send welcome email
//                                   (or activate a Pay to Park session)
//   invoice.paid                  → keep permit active, send receipt
//   invoice.payment_failed        → warn tenant + manager
//   customer.subscription.deleted → suspend permit, notify manager

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { hashPassword } = require('./lib/unit-password');
const { send, sendRaw, logoHeader } = require('./send-email');
const { activateSession } = require('./lib/parking');

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

  // Pay to Park: payment confirmed → session becomes active and visible to enforcement
  if (meta.kind === 'parking_session') {
    const row = await activateSession(session);
    console.log('Pay to Park session', row ? `activated: ${row.plate}` : 'not found', session.id);
    return;
  }

  // A paid spot added after sign-up (unit portal button or manager's payment link)
  if (meta.kind === 'spot_addon') {
    if (!/^[0-9a-f-]{36}$/i.test(String(meta.slot_id || ''))) return;
    await sbUpdate('property_units',
      { spot_paid: true, paid_via: 'card', spot_subscription_id: session.subscription || null, stripe_customer_id: session.customer || null },
      `id=eq.${meta.slot_id}&property_id=eq.${meta.property_id}&billing_type=eq.monthly`);
    console.log(`Spot ${meta.slot_id} paid for Unit ${meta.unit_number}`);
    try { await spotAddedEmails(meta, session); }
    catch (e) { console.error('Spot added emails failed (non-fatal):', e.message); }
    return;
  }
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

  // 1b. Mark the paid spots the resident paid for (older checkouts: the invite spot)
  try {
    const unitFilter = `property_id=eq.${property_id}&unit_number=eq.${encodeURIComponent(unit_number)}&billing_type=eq.monthly`;
    const ids = String(meta.spot_ids || '').split(',').filter(id => /^[0-9a-f-]{36}$/i.test(id));
    await sbUpdate('property_units',
      { spot_paid: true, paid_via: 'card', spot_subscription_id: session.subscription || null, stripe_customer_id: session.customer || null },
      ids.length ? `${unitFilter}&id=in.(${ids.join(',')})` : `${unitFilter}&invite_code=eq.${encodeURIComponent(invite_code)}`);
  } catch (e) { console.error('Marking paid spots failed (non-fatal):', e.message); }

  // 2. Generate password and save to ALL slots for this unit (some slots have null invite_code)
  const password = generatePassword();
  await sbUpdate(
    'property_units',
    { unit_password: hashPassword(password) },
    `property_id=eq.${property_id}&unit_number=eq.${encodeURIComponent(unit_number)}`
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

// Confirmation to the resident + heads-up to the manager when a spot is added
const escH = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function emailShell(color, title, intro, rows, button, footnote) {
  const table = rows.map(([k, v]) => `<tr><td style="padding:5px 0;color:#64748b;font-size:13px;">${escH(k)}</td><td style="padding:5px 0;text-align:right;font-weight:700;">${escH(v)}</td></tr>`).join('');
  return `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 16px;color:#0f172a;background:#ffffff;">
  ${logoHeader(color)}
  <h2 style="margin:0 0 8px;">${escH(title)}</h2>
  <p style="color:#475569;margin:0 0 20px;line-height:1.5;">${intro}</p>
  <div style="background:#f4f7ff;border-radius:10px;padding:14px 20px;margin-bottom:22px;"><table width="100%" cellpadding="0" cellspacing="0">${table}</table></div>
  <p style="text-align:center;margin:0 0 20px;"><a href="${button[1]}" style="display:inline-block;background:${color};color:#ffffff;text-decoration:none;padding:13px 28px;border-radius:9px;font-weight:700;">${escH(button[0])}</a></p>
  ${footnote ? `<p style="color:#94a3b8;font-size:12px;text-align:center;">${footnote}</p>` : ''}
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;">
  <p style="color:#94a3b8;font-size:11px;text-align:center;">© ${new Date().getFullYear()} My Spot Parking Inc.</p>
</body></html>`;
}
async function spotAddedEmails(meta, session) {
  const [slot] = await sbSelect('property_units', `id=eq.${meta.slot_id}&select=*`);
  const [unitRow] = await sbSelect('property_units', `property_id=eq.${meta.property_id}&unit_number=eq.${encodeURIComponent(meta.unit_number)}&tenant_email=not.is.null&select=tenant_email,tenant_name&limit=1`);
  const [property] = await sbSelect('properties', `id=eq.${meta.property_id}&select=name,manager_email`);
  const spot = slot?.slot_label || 'Your new spot';
  const price = session.amount_total != null ? `$${(session.amount_total / 100).toFixed(2)} / month` : '';
  const propertyName = property?.name || 'your property';
  const residentEmail = session.customer_details?.email || unitRow?.tenant_email;
  const residentName = session.customer_details?.name || unitRow?.tenant_name || 'Resident';
  const date = new Date().toLocaleDateString('en-US', { timeZone: 'America/Denver', month: 'short', day: 'numeric', year: 'numeric' });
  const rows = [['Property', propertyName], ['Unit', meta.unit_number], ['Spot', spot], ['Price', price], ['Started', date]];

  if (residentEmail) {
    await sendRaw({
      to: residentEmail,
      subject: `${spot} is now active — Unit ${meta.unit_number}`,
      html: emailShell('#059669', `${spot} is now active`,
        `Thanks! Your payment went through and ${escH(spot)} has been added to Unit ${escH(meta.unit_number)}. You can assign a vehicle to it in your unit portal now.`,
        rows, ['Open My Unit →', `${SITE}/unit.html`],
        'Billed monthly by card. To update your card or cancel this spot, open Account → Manage Billing in your unit portal.'),
      text: `${spot} is now active on Unit ${meta.unit_number} at ${propertyName} (${price}).\n\nAssign a vehicle: ${SITE}/unit.html\nTo update your card or cancel, open Account → Manage Billing in your unit portal.`,
    });
  }
  if (property?.manager_email) {
    await sendRaw({
      to: property.manager_email,
      subject: `Unit ${meta.unit_number} added ${spot} (${price}) — ${propertyName}`,
      html: emailShell('#2859a8', 'Paid spot added',
        `${escH(residentName)}${residentEmail ? ' (' + escH(residentEmail) + ')' : ''} paid for an extra spot. It now shows as <strong>PAID · CARD</strong> on your Units tab.`,
        rows, ['Open Manager Dashboard →', `${SITE}/manager.html`], ''),
      text: `Unit ${meta.unit_number} at ${propertyName} added ${spot} (${price}), paid by card.\n\n${SITE}/manager.html`,
    });
  }
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

  // Spots paid by this subscription are locked again (other spots are untouched)
  try {
    await sbUpdate('property_units', { spot_paid: false, paid_via: null, spot_subscription_id: null },
      `spot_subscription_id=eq.${encodeURIComponent(subscriptionId)}`);
  } catch (e) { console.error('Clearing paid spots failed (non-fatal):', e.message); }

  await sbUpdate('permits', { billing_status: 'suspended', status: 'revoked' }, `stripe_subscription_id=eq.${subscriptionId}`);

  const permits = await sbSelect('permits', `stripe_subscription_id=eq.${subscriptionId}&select=*`);
  const permit = permits?.[0];
  if (!permit) return;

  // Older sign-ups didn't record which subscription paid which spot
  try {
    await sbUpdate('property_units', { spot_paid: false, paid_via: null },
      `property_id=eq.${permit.property_id}&unit_number=eq.${encodeURIComponent(permit.unit_number || '')}&billing_type=eq.monthly&paid_via=eq.card&spot_subscription_id=is.null`);
  } catch (e) { console.error('Clearing paid spots failed (non-fatal):', e.message); }

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
