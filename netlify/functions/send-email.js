// send-email.js — AWS SES email sender
// Provider-agnostic wrapper: swap sendViaSES for another provider if needed

const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');

const ses = new SESClient({
  region: process.env.AWS_SES_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_SES_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SES_SECRET_ACCESS_KEY,
  },
});

const FROM = process.env.AWS_SES_FROM_EMAIL || 'noreply@myspotparking.com';
const SITE = process.env.SITE_URL || 'https://myspotparking.com';

// ── Email-safe logo header ───────────────────────────────────────────────────
// Uses a table-based layout (email client safe) with an inline SVG logo mark.
// Most modern email clients (Gmail, Apple Mail, Outlook 2019+) render inline SVG.
// The pin shape is rendered as a CSS-clipped div for maximum compatibility.
function logoHeader(accentColor = '#2859a8') {
  return `
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:28px;">
    <tr>
      <td align="center" style="background:${accentColor};border-radius:14px;padding:28px 24px;">
        <table cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td align="center" style="padding-bottom:10px;">
              <!--[if !mso]><!-->
              <svg width="52" height="44" viewBox="0 0 80 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M11 40 L8 54 L20 54" stroke="rgba(255,255,255,0.6)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M69 40 L72 54 L60 54" stroke="rgba(255,255,255,0.6)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
                <ellipse cx="40" cy="57" rx="8" ry="3" fill="rgba(0,0,0,0.2)"/>
                <path d="M40 4C31.163 4 24 11.163 24 20c0 11.2 16 33 16 33S56 31.2 56 20c0-8.837-7.163-16-16-16z" fill="white"/>
                <circle cx="40" cy="20" r="10" fill="${accentColor}"/>
                <text x="40" y="25" text-anchor="middle" font-family="Arial Black,Arial,sans-serif" font-weight="900" font-size="13" fill="white">P</text>
              </svg>
              <!--<![endif]-->
            </td>
          </tr>
          <tr>
            <td align="center">
              <span style="color:#ffffff;font-size:22px;font-weight:800;font-family:Arial,sans-serif;letter-spacing:-0.5px;">Lot<b style="color:#2859a8;font-weight:inherit;">HQ</b></span>
              <span style="color:rgba(255,255,255,0.75);font-size:13px;font-weight:600;font-family:Arial,sans-serif;letter-spacing:2px;text-transform:uppercase;display:block;margin-top:2px;">— PARKING —</span>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>`;
}

// ── Core send function ───────────────────────────────────────
async function sendViaSES({ to, subject, html, text }) {
  const cmd = new SendEmailCommand({
    Source: `LotHQ <${FROM}>`,
    Destination: { ToAddresses: [to] },
    Message: {
      Subject: { Data: subject, Charset: 'UTF-8' },
      Body: {
        Html: { Data: html, Charset: 'UTF-8' },
        Text: { Data: text || subject, Charset: 'UTF-8' },
      },
    },
  });
  return ses.send(cmd);
}

// ── Email templates ──────────────────────────────────────────

// Sign-in link with the property and unit already filled in
const unitLoginUrl = (propertyId, unitNumber) => `${SITE}/unit.html` +
  (propertyId ? `?property=${encodeURIComponent(propertyId)}${unitNumber ? '&unit=' + encodeURIComponent(unitNumber) : ''}` : '');

function welcomeEmail({ name, email, password, propertyName, unitNumber, plate, propertyId }) {
  const loginUrl = unitLoginUrl(propertyId, unitNumber);
  return {
    subject: `Your parking permit is active — ${propertyName}`,
    html: `
<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 16px;color:#0f172a;background:#ffffff;">
  ${logoHeader('#2859a8')}
  <h2 style="margin:0 0 8px;font-family:Arial,sans-serif;color:#0f172a;">Welcome, ${name}!</h2>
  <p style="color:#475569;margin:0 0 24px;">Your parking permit for <strong>${propertyName}</strong> — Unit <strong>${unitNumber}</strong> is now active.</p>
  <div style="background:#f4f7ff;border-radius:10px;padding:20px;margin-bottom:24px;">
    <div style="font-size:12px;color:#64748b;margin-bottom:4px;letter-spacing:0.08em;font-weight:600;">UNIT NUMBER</div>
    <div style="font-size:16px;font-weight:700;font-family:monospace;color:#0f172a;">${unitNumber}</div>
    <div style="font-size:12px;color:#64748b;margin:14px 0 4px;letter-spacing:0.08em;font-weight:600;">PASSWORD</div>
    <div style="font-size:22px;font-weight:700;font-family:monospace;letter-spacing:2px;color:#2859a8;">${password}</div>
  </div>
  ${plate ? `<p style="color:#475569;margin:0 0 24px;">Active vehicle: <strong style="font-family:monospace;">${plate}</strong></p>` : ''}
  <a href="${loginUrl}" style="display:block;background:#2859a8;color:#fff;text-decoration:none;text-align:center;padding:14px;border-radius:9px;font-weight:700;font-size:15px;margin-bottom:24px;font-family:Arial,sans-serif;">Log In to Your Portal →</a>
  <p style="color:#94a3b8;font-size:12px;">Log in using your unit number and the password above. Keep this email — it contains your login credentials.</p>
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;">
  <p style="color:#94a3b8;font-size:11px;text-align:center;">© ${new Date().getFullYear()} LotHQ · Provo, UT</p>
</body></html>`,
    text: `Welcome to LotHQ!\n\nProperty: ${propertyName}\nUnit: ${unitNumber}\n\nUnit Number: ${unitNumber}\nPassword: ${password}\n\nLog in at: ${loginUrl}`,
  };
}

function paymentFailedEmail({ name, email, propertyName, portalUrl }) {
  return {
    subject: `Action required — parking permit payment failed`,
    html: `
<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 16px;color:#0f172a;background:#ffffff;">
  ${logoHeader('#dc2626')}
  <h2 style="margin:0 0 8px;font-family:Arial,sans-serif;color:#0f172a;">Payment Failed</h2>
  <p style="color:#475569;margin:0 0 24px;">Hi ${name}, we were unable to process your parking permit payment for <strong>${propertyName}</strong>. Please update your payment method to keep your permit active.</p>
  <a href="${portalUrl}" style="display:block;background:#dc2626;color:#fff;text-decoration:none;text-align:center;padding:14px;border-radius:9px;font-weight:700;font-size:15px;margin-bottom:24px;font-family:Arial,sans-serif;">Update Payment Method →</a>
  <p style="color:#94a3b8;font-size:12px;">If payment is not received within 7 days your permit may be suspended. Contact your property manager if you have questions.</p>
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;">
  <p style="color:#94a3b8;font-size:11px;text-align:center;">© ${new Date().getFullYear()} LotHQ</p>
</body></html>`,
    text: `Hi ${name},\n\nYour parking permit payment for ${propertyName} failed. Update your payment method here: ${portalUrl}`,
  };
}

function permitSuspendedEmail({ name, propertyName, unitNumber }) {
  return {
    subject: `Your parking permit has been suspended — ${propertyName}`,
    html: `
<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 16px;color:#0f172a;background:#ffffff;">
  ${logoHeader('#d97706')}
  <h2 style="margin:0 0 8px;font-family:Arial,sans-serif;color:#0f172a;">Permit Suspended</h2>
  <p style="color:#475569;margin:0 0 24px;">Hi ${name}, your parking permit for <strong>${propertyName}</strong> — Unit <strong>${unitNumber}</strong> has been suspended due to non-payment.</p>
  <p style="color:#475569;margin:0 0 24px;">Please contact your property manager to reinstate your permit.</p>
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;">
  <p style="color:#94a3b8;font-size:11px;text-align:center;">© ${new Date().getFullYear()} LotHQ</p>
</body></html>`,
    text: `Hi ${name},\n\nYour parking permit for ${propertyName} Unit ${unitNumber} has been suspended. Contact your property manager to reinstate it.`,
  };
}

function renewalReminderEmail({ name, propertyName, renewalDate, portalUrl }) {
  return {
    subject: `Your parking permit renews on ${renewalDate} — ${propertyName}`,
    html: `
<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 16px;color:#0f172a;background:#ffffff;">
  ${logoHeader('#2859a8')}
  <h2 style="margin:0 0 8px;font-family:Arial,sans-serif;color:#0f172a;">Renewal Reminder</h2>
  <p style="color:#475569;margin:0 0 24px;">Hi ${name}, your parking permit for <strong>${propertyName}</strong> will automatically renew on <strong>${renewalDate}</strong>.</p>
  <a href="${portalUrl}" style="display:block;background:#2859a8;color:#fff;text-decoration:none;text-align:center;padding:14px;border-radius:9px;font-weight:700;font-size:15px;margin-bottom:24px;font-family:Arial,sans-serif;">Manage Billing →</a>
  <p style="color:#94a3b8;font-size:12px;">No action needed if your payment info is up to date.</p>
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;">
  <p style="color:#94a3b8;font-size:11px;text-align:center;">© ${new Date().getFullYear()} LotHQ</p>
</body></html>`,
    text: `Hi ${name},\n\nYour parking permit for ${propertyName} renews on ${renewalDate}. Manage billing: ${portalUrl}`,
  };
}

function inviteFlyerEmail({ email, propertyName, unitNumber, inviteCode, inviteLink }) {
  return {
    subject: `Your parking invite — ${propertyName} Unit ${unitNumber}`,
    html: `
<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 16px;color:#0f172a;background:#ffffff;">
  ${logoHeader('#2859a8')}
  <h2 style="margin:0 0 8px;font-family:Arial,sans-serif;color:#0f172a;">You've been invited!</h2>
  <p style="color:#475569;margin:0 0 24px;">Your property manager has set up a parking spot for you at <strong>${propertyName}</strong> — Unit <strong>${unitNumber}</strong>.</p>
  <div style="background:#f4f7ff;border-radius:10px;padding:20px;margin-bottom:24px;text-align:center;">
    <div style="font-size:12px;color:#64748b;margin-bottom:8px;letter-spacing:0.08em;font-weight:600;">YOUR INVITE CODE</div>
    <div style="font-size:28px;font-weight:800;font-family:monospace;letter-spacing:4px;color:#2859a8;">${inviteCode}</div>
  </div>
  <p style="color:#475569;margin:0 0 16px;">Click below to set up your parking permit. It only takes a few minutes.</p>
  <a href="${inviteLink}" style="display:block;background:#2859a8;color:#fff;text-decoration:none;text-align:center;padding:14px;border-radius:9px;font-weight:700;font-size:15px;margin-bottom:24px;font-family:Arial,sans-serif;">Set Up My Parking →</a>
  <p style="color:#94a3b8;font-size:12px;">Or copy this link: ${inviteLink}</p>
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;">
  <p style="color:#94a3b8;font-size:11px;text-align:center;">© ${new Date().getFullYear()} LotHQ · Provo, UT</p>
</body></html>`,
    text: `You've been invited to set up parking at ${propertyName} Unit ${unitNumber}.\n\nInvite Code: ${inviteCode}\n\nSign up here: ${inviteLink}`,
  };
}

function passwordResetEmail({ name, password, propertyName, unitNumber, propertyId }) {
  const loginUrl = unitLoginUrl(propertyId, unitNumber);
  return {
    subject: `Your new temporary password — ${propertyName}`,
    html: `
<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 16px;color:#0f172a;background:#ffffff;">
  ${logoHeader('#2859a8')}
  <h2 style="margin:0 0 8px;font-family:Arial,sans-serif;color:#0f172a;">Password Reset</h2>
  <p style="color:#475569;margin:0 0 24px;">Hi ${name}, here is your new temporary password for <strong>${propertyName}</strong> — Unit <strong>${unitNumber}</strong>.</p>
  <div style="background:#f4f7ff;border-radius:10px;padding:20px;margin-bottom:24px;">
    <div style="font-size:12px;color:#64748b;margin-bottom:4px;letter-spacing:0.08em;font-weight:600;">UNIT NUMBER</div>
    <div style="font-size:16px;font-weight:700;font-family:monospace;color:#0f172a;">${unitNumber}</div>
    <div style="font-size:12px;color:#64748b;margin:14px 0 4px;letter-spacing:0.08em;font-weight:600;">NEW TEMPORARY PASSWORD</div>
    <div style="font-size:22px;font-weight:700;font-family:monospace;letter-spacing:2px;color:#2859a8;">${password}</div>
  </div>
  <a href="${loginUrl}" style="display:block;background:#2859a8;color:#fff;text-decoration:none;text-align:center;padding:14px;border-radius:9px;font-weight:700;font-size:15px;margin-bottom:24px;font-family:Arial,sans-serif;">Log In to Your Portal →</a>
  <p style="color:#94a3b8;font-size:12px;">Once logged in, go to Account to set a permanent password. If you didn't request this reset, contact your property manager.</p>
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;">
  <p style="color:#94a3b8;font-size:11px;text-align:center;">© ${new Date().getFullYear()} LotHQ · Provo, UT</p>
</body></html>`,
    text: `Password Reset\n\nHi ${name},\n\nYour new temporary password for ${propertyName} Unit ${unitNumber}:\n\nPassword: ${password}\n\nLog in at: ${loginUrl}\n\nSet a permanent password in Account Settings once logged in.`,
  };
}

function managerAlertEmail({ managerEmail, eventType, tenantName, tenantEmail, propertyName, unitNumber }) {
  const titles = {
    payment_failed: 'Tenant Payment Failed',
    permit_suspended: 'Permit Suspended',
    new_signup: 'New Permit Signup',
  };
  const colors = {
    payment_failed: '#dc2626',
    permit_suspended: '#d97706',
    new_signup: '#059669',
  };
  const title = titles[eventType] || 'Permit Alert';
  const color = colors[eventType] || '#2859a8';
  return {
    subject: `${title} — ${propertyName} Unit ${unitNumber}`,
    html: `
<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 16px;color:#0f172a;background:#ffffff;">
  ${logoHeader(color)}
  <h2 style="margin:0 0 16px;font-family:Arial,sans-serif;color:#0f172a;">${title}</h2>
  <div style="background:#f4f7ff;border-radius:10px;padding:20px;margin-bottom:24px;">
    <div><strong>Property:</strong> ${propertyName}</div>
    <div style="margin-top:8px;"><strong>Unit:</strong> ${unitNumber}</div>
    <div style="margin-top:8px;"><strong>Tenant:</strong> ${tenantName} (${tenantEmail})</div>
  </div>
  <a href="${SITE}/manager.html" style="display:block;background:#2859a8;color:#fff;text-decoration:none;text-align:center;padding:14px;border-radius:9px;font-weight:700;font-size:15px;font-family:Arial,sans-serif;">Open Manager Dashboard →</a>
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;">
  <p style="color:#94a3b8;font-size:11px;text-align:center;">© ${new Date().getFullYear()} LotHQ</p>
</body></html>`,
    text: `${title}\n\nProperty: ${propertyName}\nUnit: ${unitNumber}\nTenant: ${tenantName} (${tenantEmail})\n\nLog in: ${SITE}/manager.html`,
  };
}

// ── Public endpoint ──────────────────────────────────────────
// The browser may ONLY ask for one thing: a unit invite email, sent by a
// logged-in manager (or admin) for a unit at a property they manage.
// The server looks up the invite code, property name and link itself, so
// nobody can use this to send arbitrary text to arbitrary addresses.
// All other emails are sent only by server functions via exports.send().
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function reply(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
async function sbGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
  if (!res.ok) throw new Error(`Supabase ${res.status}`);
  return res.json();
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed' });
  try {
    const body = JSON.parse(event.body || '{}');
    if (body.type !== 'invite_flyer') return reply(403, { error: 'Not allowed' });

    // 1. Who is asking?
    const jwt = String(event.headers?.authorization || event.headers?.Authorization || '').replace(/^Bearer\s+/i, '');
    if (!jwt) return reply(401, { error: 'Please sign in again.' });
    const who = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${jwt}` } });
    if (!who.ok) return reply(401, { error: 'Please sign in again.' });
    const { id: userId } = await who.json();
    const [me] = await sbGet(`users?id=eq.${userId}&select=*`);

    // 2. Is this their unit?
    const to = String(body.to || '').trim().toLowerCase();
    const { propertyId } = body;
    const unitNumber = String(body.unitNumber || '').trim();
    if (!EMAIL_RE.test(to)) return reply(400, { error: 'Enter a valid email address.' });
    if (!UUID_RE.test(String(propertyId || '')) || !unitNumber) return reply(400, { error: 'Missing unit.' });
    const [prop] = await sbGet(`properties?id=eq.${propertyId}&select=name,manager_id`);
    if (!prop) return reply(404, { error: 'Property not found.' });
    const allowed = me?.role === 'admin' || (me?.role === 'manager' && prop.manager_id === userId);
    if (!allowed) return reply(403, { error: 'Not allowed' });
    const slots = await sbGet(`property_units?property_id=eq.${propertyId}&unit_number=eq.${encodeURIComponent(unitNumber)}&select=invite_code`);
    const inviteCode = slots.find(s => s.invite_code)?.invite_code;
    if (!inviteCode) return reply(400, { error: 'This unit has no invite code yet. Generate one first.' });

    // 3. Send, using only server-side data
    const template = inviteFlyerEmail({
      email: to, propertyName: prop.name || 'Your Property', unitNumber, inviteCode,
      inviteLink: `${SITE}/signup.html?code=${encodeURIComponent(inviteCode)}`,
    });
    await sendViaSES({ to, ...template });
    await require('./lib/activity').logActivity({
      actorId: userId, actorName: me?.full_name || me?.name || me?.email || null, actorRole: me?.role, portal: 'manager',
      action: 'unit.invite_sent', propertyId, target: `Unit ${unitNumber}`, summary: `Emailed the signup invite to ${to}`,
      details: { to, invite_code: inviteCode },
    });
    return reply(200, { ok: true });
  } catch (err) {
    console.error('send-email error:', err);
    return reply(500, { error: 'Could not send the email. Please try again.' });
  }
};

// Raw sender + logo header for functions that build their own email (e.g. pricing-inquiry.js)
exports.sendRaw = sendViaSES;
exports.logoHeader = logoHeader;

// Export for use by other functions (e.g. stripe-webhook.js)
exports.send =async ({ type, to, data }) => {
  let template;
  switch (type) {
    case 'welcome':         template = welcomeEmail(data); break;
    case 'payment_failed':  template = paymentFailedEmail(data); break;
    case 'suspended':       template = permitSuspendedEmail(data); break;
    case 'renewal':         template = renewalReminderEmail(data); break;
    case 'manager_alert':   template = managerAlertEmail(data); break;
    case 'invite_flyer':    template = inviteFlyerEmail(data); break;
    case 'passwordReset':   template = passwordResetEmail(data); break;
    default: throw new Error('Unknown email type: ' + type);
  }
  return sendViaSES({ to, ...template });
};
