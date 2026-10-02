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

// ── Core send function ───────────────────────────────────────
async function sendViaSES({ to, subject, html, text }) {
  const cmd = new SendEmailCommand({
    Source: `My Spot Parking <${FROM}>`,
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

function welcomeEmail({ name, email, password, propertyName, unitNumber, plate }) {
  const loginUrl = `${SITE}/unit.html`;
  return {
    subject: `Your parking permit is active — ${propertyName}`,
    html: `
<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px 16px;color:#0f172a;">
  <div style="background:#1a6fff;border-radius:12px;padding:24px;text-align:center;margin-bottom:32px;">
    <div style="font-size:32px;margin-bottom:8px;">🅿</div>
    <div style="color:#fff;font-size:20px;font-weight:700;">My Spot Parking</div>
  </div>
  <h2 style="margin:0 0 8px;">Welcome, ${name}!</h2>
  <p style="color:#475569;margin:0 0 24px;">Your parking permit for <strong>${propertyName}</strong> — Unit <strong>${unitNumber}</strong> is now active.</p>
  <div style="background:#f4f7ff;border-radius:10px;padding:20px;margin-bottom:24px;">
    <div style="font-size:13px;color:#64748b;margin-bottom:4px;">UNIT NUMBER</div>
    <div style="font-size:16px;font-weight:600;font-family:monospace;">${unitNumber}</div>
    <div style="font-size:13px;color:#64748b;margin:12px 0 4px;">PASSWORD</div>
    <div style="font-size:22px;font-weight:700;font-family:monospace;letter-spacing:2px;color:#1a6fff;">${password}</div>
  </div>
  ${plate ? `<p style="color:#475569;margin:0 0 24px;">Active vehicle: <strong style="font-family:monospace;">${plate}</strong></p>` : ''}
  <a href="${loginUrl}" style="display:block;background:#1a6fff;color:#fff;text-decoration:none;text-align:center;padding:14px;border-radius:9px;font-weight:600;font-size:15px;margin-bottom:24px;">Log In to Your Portal →</a>
  <p style="color:#94a3b8;font-size:12px;">Log in using your unit number and the password above. Keep this email — it contains your login credentials.</p>
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;">
  <p style="color:#94a3b8;font-size:11px;text-align:center;">© ${new Date().getFullYear()} My Spot Parking Inc. · Provo, UT</p>
</body></html>`,
    text: `Welcome to My Spot Parking!\n\nProperty: ${propertyName}\nUnit: ${unitNumber}\n\nUnit Number: ${unitNumber}\nPassword: ${password}\n\nLog in at: ${loginUrl}`,
  };
}

function paymentFailedEmail({ name, email, propertyName, portalUrl }) {
  return {
    subject: `Action required — parking permit payment failed`,
    html: `
<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px 16px;color:#0f172a;">
  <div style="background:#ef4444;border-radius:12px;padding:24px;text-align:center;margin-bottom:32px;">
    <div style="color:#fff;font-size:20px;font-weight:700;">⚠️ Payment Failed</div>
  </div>
  <h2 style="margin:0 0 8px;">Hi ${name},</h2>
  <p style="color:#475569;margin:0 0 24px;">We were unable to process your parking permit payment for <strong>${propertyName}</strong>. Please update your payment method to keep your permit active.</p>
  <a href="${portalUrl}" style="display:block;background:#ef4444;color:#fff;text-decoration:none;text-align:center;padding:14px;border-radius:9px;font-weight:600;font-size:15px;margin-bottom:24px;">Update Payment Method →</a>
  <p style="color:#94a3b8;font-size:12px;">If payment is not received within 7 days your permit may be suspended. Contact your property manager if you have questions.</p>
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;">
  <p style="color:#94a3b8;font-size:11px;text-align:center;">© ${new Date().getFullYear()} My Spot Parking Inc.</p>
</body></html>`,
    text: `Hi ${name},\n\nYour parking permit payment for ${propertyName} failed. Update your payment method here: ${portalUrl}`,
  };
}

function permitSuspendedEmail({ name, propertyName, unitNumber }) {
  return {
    subject: `Your parking permit has been suspended — ${propertyName}`,
    html: `
<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px 16px;color:#0f172a;">
  <div style="background:#f59e0b;border-radius:12px;padding:24px;text-align:center;margin-bottom:32px;">
    <div style="color:#fff;font-size:20px;font-weight:700;">🚫 Permit Suspended</div>
  </div>
  <h2 style="margin:0 0 8px;">Hi ${name},</h2>
  <p style="color:#475569;margin:0 0 24px;">Your parking permit for <strong>${propertyName}</strong> — Unit <strong>${unitNumber}</strong> has been suspended due to non-payment.</p>
  <p style="color:#475569;margin:0 0 24px;">Please contact your property manager to reinstate your permit.</p>
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;">
  <p style="color:#94a3b8;font-size:11px;text-align:center;">© ${new Date().getFullYear()} My Spot Parking Inc.</p>
</body></html>`,
    text: `Hi ${name},\n\nYour parking permit for ${propertyName} Unit ${unitNumber} has been suspended. Contact your property manager to reinstate it.`,
  };
}

function renewalReminderEmail({ name, propertyName, renewalDate, portalUrl }) {
  return {
    subject: `Your parking permit renews on ${renewalDate} — ${propertyName}`,
    html: `
<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px 16px;color:#0f172a;">
  <div style="background:#1a6fff;border-radius:12px;padding:24px;text-align:center;margin-bottom:32px;">
    <div style="color:#fff;font-size:20px;font-weight:700;">🅿 Renewal Reminder</div>
  </div>
  <h2 style="margin:0 0 8px;">Hi ${name},</h2>
  <p style="color:#475569;margin:0 0 24px;">Your parking permit for <strong>${propertyName}</strong> will automatically renew on <strong>${renewalDate}</strong>.</p>
  <a href="${portalUrl}" style="display:block;background:#1a6fff;color:#fff;text-decoration:none;text-align:center;padding:14px;border-radius:9px;font-weight:600;font-size:15px;margin-bottom:24px;">Manage Billing →</a>
  <p style="color:#94a3b8;font-size:12px;">No action needed if your payment info is up to date.</p>
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;">
  <p style="color:#94a3b8;font-size:11px;text-align:center;">© ${new Date().getFullYear()} My Spot Parking Inc.</p>
</body></html>`,
    text: `Hi ${name},\n\nYour parking permit for ${propertyName} renews on ${renewalDate}. Manage billing: ${portalUrl}`,
  };
}

function inviteFlyerEmail({ email, propertyName, unitNumber, inviteCode, inviteLink }) {
  return {
    subject: `Your parking invite — ${propertyName} Unit ${unitNumber}`,
    html: `
<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px 16px;color:#0f172a;">
  <div style="background:#1a6fff;border-radius:12px;padding:24px;text-align:center;margin-bottom:32px;">
    <div style="font-size:32px;margin-bottom:8px;">🅿</div>
    <div style="color:#fff;font-size:20px;font-weight:700;">My Spot Parking</div>
  </div>
  <h2 style="margin:0 0 8px;">You've been invited!</h2>
  <p style="color:#475569;margin:0 0 24px;">Your property manager has set up a parking spot for you at <strong>${propertyName}</strong> — Unit <strong>${unitNumber}</strong>.</p>
  <div style="background:#f4f7ff;border-radius:10px;padding:20px;margin-bottom:24px;text-align:center;">
    <div style="font-size:13px;color:#64748b;margin-bottom:8px;">YOUR INVITE CODE</div>
    <div style="font-size:28px;font-weight:800;font-family:monospace;letter-spacing:4px;color:#1a6fff;">${inviteCode}</div>
  </div>
  <p style="color:#475569;margin:0 0 16px;">Click below to set up your parking permit. It only takes a few minutes.</p>
  <a href="${inviteLink}" style="display:block;background:#1a6fff;color:#fff;text-decoration:none;text-align:center;padding:14px;border-radius:9px;font-weight:600;font-size:15px;margin-bottom:24px;">Set Up My Parking →</a>
  <p style="color:#94a3b8;font-size:12px;">Or copy this link: ${inviteLink}</p>
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;">
  <p style="color:#94a3b8;font-size:11px;text-align:center;">© ${new Date().getFullYear()} My Spot Parking Inc. · Provo, UT</p>
</body></html>`,
    text: `You've been invited to set up parking at ${propertyName} Unit ${unitNumber}.\n\nInvite Code: ${inviteCode}\n\nSign up here: ${inviteLink}`,
  };
}

function passwordResetEmail({ name, password, propertyName, unitNumber }) {
  const loginUrl = `${SITE}/unit.html`;
  return {
    subject: `Your new temporary password — ${propertyName}`,
    html: `
<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px 16px;color:#0f172a;">
  <div style="background:#1a6fff;border-radius:12px;padding:24px;text-align:center;margin-bottom:32px;">
    <div style="font-size:32px;margin-bottom:8px;">🔑</div>
    <div style="color:#fff;font-size:20px;font-weight:700;">My Spot Parking</div>
  </div>
  <h2 style="margin:0 0 8px;">Password Reset</h2>
  <p style="color:#475569;margin:0 0 24px;">Hi ${name}, here is your new temporary password for <strong>${propertyName}</strong> — Unit <strong>${unitNumber}</strong>.</p>
  <div style="background:#f4f7ff;border-radius:10px;padding:20px;margin-bottom:24px;">
    <div style="font-size:13px;color:#64748b;margin-bottom:4px;">UNIT NUMBER</div>
    <div style="font-size:16px;font-weight:600;font-family:monospace;">${unitNumber}</div>
    <div style="font-size:13px;color:#64748b;margin:12px 0 4px;">NEW TEMPORARY PASSWORD</div>
    <div style="font-size:22px;font-weight:700;font-family:monospace;letter-spacing:2px;color:#1a6fff;">${password}</div>
  </div>
  <a href="${loginUrl}" style="display:block;background:#1a6fff;color:#fff;text-decoration:none;text-align:center;padding:14px;border-radius:9px;font-weight:600;font-size:15px;margin-bottom:24px;">Log In to Your Portal →</a>
  <p style="color:#94a3b8;font-size:12px;">Once logged in, go to ⚙ Account to set a permanent password. If you didn't request this reset, contact your property manager.</p>
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;">
  <p style="color:#94a3b8;font-size:11px;text-align:center;">© ${new Date().getFullYear()} My Spot Parking Inc. · Provo, UT</p>
</body></html>`,
    text: `Password Reset\n\nHi ${name},\n\nYour new temporary password for ${propertyName} Unit ${unitNumber}:\n\nPassword: ${password}\n\nLog in at: ${loginUrl}\n\nSet a permanent password in Account Settings once logged in.`,
  };
}

function managerAlertEmail({ managerEmail, eventType, tenantName, tenantEmail, propertyName, unitNumber }) {
  const titles = {
    payment_failed: '⚠️ Tenant Payment Failed',
    permit_suspended: '🚫 Permit Suspended',
    new_signup: '✅ New Permit Signup',
  };
  const title = titles[eventType] || 'Permit Alert';
  return {
    subject: `${title} — ${propertyName} Unit ${unitNumber}`,
    html: `
<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px 16px;color:#0f172a;">
  <h2 style="margin:0 0 16px;">${title}</h2>
  <div style="background:#f4f7ff;border-radius:10px;padding:20px;margin-bottom:24px;">
    <div><strong>Property:</strong> ${propertyName}</div>
    <div style="margin-top:8px;"><strong>Unit:</strong> ${unitNumber}</div>
    <div style="margin-top:8px;"><strong>Tenant:</strong> ${tenantName} (${tenantEmail})</div>
  </div>
  <a href="${SITE}/manager.html" style="display:block;background:#1a6fff;color:#fff;text-decoration:none;text-align:center;padding:14px;border-radius:9px;font-weight:600;font-size:15px;">Open Manager Dashboard →</a>
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;">
  <p style="color:#94a3b8;font-size:11px;text-align:center;">© ${new Date().getFullYear()} My Spot Parking Inc.</p>
</body></html>`,
    text: `${title}\n\nProperty: ${propertyName}\nUnit: ${unitNumber}\nTenant: ${tenantName} (${tenantEmail})\n\nLog in: ${SITE}/manager.html`,
  };
}

// ── Lambda handler (called directly or via other functions) ──
exports.handler = async (event) => {
  if (event.httpMethod && event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const body = typeof event.body === 'string' ? JSON.parse(event.body) : event;
    const { type, to, data } = body;

    let template;
    switch (type) {
      case 'welcome':         template = welcomeEmail(data); break;
      case 'payment_failed':  template = paymentFailedEmail(data); break;
      case 'suspended':       template = permitSuspendedEmail(data); break;
      case 'renewal':         template = renewalReminderEmail(data); break;
      case 'manager_alert':   template = managerAlertEmail(data); break;
      case 'invite_flyer':    template = inviteFlyerEmail(data); break;
      case 'passwordReset':   template = passwordResetEmail(data); break;
      default:
        return { statusCode: 400, body: JSON.stringify({ error: 'Unknown email type: ' + type }) };
    }

    await sendViaSES({ to, ...template });
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };

  } catch (err) {
    console.error('send-email error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

// Export for use by other functions (e.g. stripe-webhook.js)
exports.send = async ({ type, to, data }) => {
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