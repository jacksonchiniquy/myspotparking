// create-free-permit.js — completes unit signup for slots with billing_type = 'free'
// No Stripe involved. Mirrors what stripe-webhook does after checkout.session.completed.

const { send } = require('./send-email');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SITE = process.env.SITE_URL || 'https://myspotparking.com';

function sbHeaders() {
  return {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Prefer': 'return=representation',
  };
}

async function sbSelect(table, filters = '') {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filters}`, { headers: sbHeaders() });
  return res.json();
}

async function sbInsert(table, data) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST', headers: sbHeaders(), body: JSON.stringify(data),
  });
  return res.json();
}

async function sbUpdate(table, data, filters) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filters}`, {
    method: 'PATCH', headers: sbHeaders(), body: JSON.stringify(data),
  });
  return res.json();
}

function generatePassword(length = 10) {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { inviteCode, propertyId, unitNumber, tenantName, tenantEmail } = JSON.parse(event.body);

    if (!inviteCode || !propertyId || !tenantEmail) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields' }) };
    }

    // Verify invite code and that slot is actually free
    const units = await sbSelect('property_units', `invite_code=eq.${encodeURIComponent(inviteCode)}&select=*`);
    const unit = Array.isArray(units) ? units[0] : null;
    if (!unit) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid invite code' }) };
    }
    if (unit.invite_used) {
      return { statusCode: 400, body: JSON.stringify({ error: 'This invite has already been used' }) };
    }
    if (unit.billing_type === 'monthly') {
      return { statusCode: 400, body: JSON.stringify({ error: 'This slot requires payment — use the payment flow' }) };
    }

    // Get property name
    const properties = await sbSelect('properties', `id=eq.${propertyId}&select=name`);
    const propertyName = Array.isArray(properties) ? (properties[0]?.name || 'Your Property') : 'Your Property';

    // 1. Mark invite as used
    await sbUpdate(
      'property_units',
      { invite_used: true, invite_used_at: new Date().toISOString(), tenant_email: tenantEmail, tenant_name: tenantName },
      `invite_code=eq.${encodeURIComponent(inviteCode)}`
    );

    // 2. Generate a password for the tenant's account
    const password = generatePassword();
    await sbUpdate('property_units', { unit_password: password }, `invite_code=eq.${encodeURIComponent(inviteCode)}`);

    // 3. Create Supabase auth user
    let userId = null;
    try {
      const authRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
        body: JSON.stringify({
          email: tenantEmail,
          password,
          email_confirm: true,
          user_metadata: { name: tenantName, role: 'holder' },
        }),
      });
      const authData = await authRes.json();
      userId = authData?.id || null;
    } catch (e) {
      console.warn('Auth user creation failed (may already exist):', e.message);
    }

    // 4. Upsert users table row
    if (userId) {
      await sbInsert('users', {
        id: userId,
        email: tenantEmail,
        name: tenantName,
        role: 'holder',
        property_id: propertyId,
      });
    }

    // 5. Create permit (no billing fields)
    await sbInsert('permits', {
      property_id: propertyId,
      holder_id: userId || null,
      holder_email: tenantEmail,
      holder_name: tenantName,
      unit_number: unitNumber,
      invite_code: inviteCode,
      status: 'active',
      billing_status: 'free',
      billing_interval: null,
      source: 'unit_invite',
    });

    // 6. Send welcome email
    try {
      await send({
        type: 'welcome',
        to: tenantEmail,
        data: {
          name: tenantName,
          email: tenantEmail,
          password,
          propertyName,
          unitNumber,
          loginUrl: `${SITE}/holder.html`,
        },
      });
    } catch (e) {
      console.warn('Welcome email failed:', e.message);
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true }),
    };

  } catch (err) {
    console.error('create-free-permit error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
