// pricing-inquiry.js — receives demo/pricing requests from the pricing page form.
// 1) Saves the lead to Supabase (table: pricing_inquiries) so nothing is lost.
// 2) Emails a notification to LEADS_NOTIFY_EMAIL (defaults to jackson@chiniquy.com).
// Succeeds if EITHER step works; only reports failure if both fail.

const { sendRaw, logoHeader } = require('./send-email');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const NOTIFY_TO = process.env.LEADS_NOTIFY_EMAIL || 'jackson@chiniquy.com';

const UNIT_OPTIONS = ['Under 20', '20–50', '51–100', '101–250', '250+'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function reply(statusCode, body) {
  return { statusCode, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

// Trim, cap length, and turn non-strings into ''
function clean(value, max = 200) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

// Make user text safe to put inside an HTML email
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function saveLead(lead) {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase not configured');
  const res = await fetch(`${SUPABASE_URL}/rest/v1/pricing_inquiries`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(lead),
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
}

function leadEmail(lead) {
  const name = `${lead.first_name} ${lead.last_name}`;
  const rows = [
    ['Name', name],
    ['Email', lead.email],
    ['Phone', lead.phone || '—'],
    ['Property / Company', lead.company],
    ['Units', lead.units],
    ['State', lead.state || '—'],
  ];
  const rowsHtml = rows.map(([k, v]) =>
    `<div style="margin-top:8px;"><strong>${k}:</strong> ${esc(v)}</div>`).join('');
  const messageHtml = lead.message
    ? `<div style="margin-top:16px;"><strong>Message:</strong><div style="white-space:pre-wrap;margin-top:4px;color:#475569;">${esc(lead.message)}</div></div>`
    : '';

  return {
    to: NOTIFY_TO,
    subject: `New demo request — ${lead.company} (${lead.units} units)`,
    html: `
<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 16px;color:#0f172a;background:#ffffff;">
  ${logoHeader('#059669')}
  <h2 style="margin:0 0 16px;font-family:Arial,sans-serif;color:#0f172a;">New Demo Request</h2>
  <div style="background:#f4f7ff;border-radius:10px;padding:20px;margin-bottom:24px;">${rowsHtml}${messageHtml}</div>
  <a href="mailto:${esc(lead.email)}" style="display:block;background:#059669;color:#fff;text-decoration:none;text-align:center;padding:14px;border-radius:9px;font-weight:700;font-size:15px;font-family:Arial,sans-serif;">Reply to ${esc(lead.first_name)} →</a>
</body></html>`,
    text: rows.map(([k, v]) => `${k}: ${v}`).join('\n') + (lead.message ? `\n\nMessage:\n${lead.message}` : ''),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return reply(400, { error: 'Invalid request' }); }

  // Spam trap: real visitors never see or fill the hidden "website" field.
  // Pretend success so bots don't learn they were caught.
  if (clean(body.website)) return reply(200, { ok: true });

  const lead = {
    first_name: clean(body.fname, 80),
    last_name:  clean(body.lname, 80),
    email:      clean(body.email, 200).toLowerCase(),
    phone:      clean(body.phone, 40),
    company:    clean(body.company, 200),
    units:      clean(body.units, 20),
    state:      clean(body.state, 40),
    message:    clean(body.message, 2000),
    source:     clean(body.source, 80) || 'pricing-page',
  };

  const missing = ['first_name', 'last_name', 'email', 'company', 'units'].filter(k => !lead[k]);
  if (missing.length) return reply(400, { error: 'Please fill in: ' + missing.join(', ').replace(/_/g, ' ') });
  if (!EMAIL_RE.test(lead.email)) return reply(400, { error: 'Please enter a valid email address' });
  if (!UNIT_OPTIONS.includes(lead.units)) return reply(400, { error: 'Please choose a unit range' });

  const [saved, emailed] = await Promise.allSettled([saveLead(lead), sendRaw(leadEmail(lead))]);
  if (saved.status === 'rejected') console.error('pricing-inquiry save failed:', saved.reason);
  if (emailed.status === 'rejected') console.error('pricing-inquiry email failed:', emailed.reason);

  if (saved.status === 'rejected' && emailed.status === 'rejected') {
    return reply(500, { error: 'We could not send your request. Please email info@myspotparking.com.' });
  }
  return reply(200, { ok: true });
};
