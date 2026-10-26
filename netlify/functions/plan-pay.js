// plan-pay.js — the "Start LotHQ subscription" link LotHQ sends a client.
// GET ?t=<signed link> → opens a fresh Stripe checkout for that property's
// LotHQ subscription (the amount and monthly/yearly set in Admin → Billing).
// The link is signed so nobody can change the price, and lasts 30 days.
// (Stripe checkout pages expire after a day, so the email links here instead.)

const crypto = require('crypto');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SITE = process.env.SITE_URL || 'https://myspotparking.com';
const LINK_DAYS = 30;

const KEY = () => crypto.createHash('sha256').update('plan-pay:' + SUPABASE_KEY).digest();
function makePlanLink(propertyId) {
  const payload = Buffer.from(JSON.stringify({ p: propertyId, exp: Date.now() + LINK_DAYS * 864e5 })).toString('base64url');
  const sig = crypto.createHmac('sha256', KEY()).update(payload).digest('base64url');
  return `${SITE}/.netlify/functions/plan-pay?t=${payload}.${sig}`;
}
function readPlanLink(token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) return null;
  const expect = crypto.createHmac('sha256', KEY()).update(payload).digest('base64url');
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.exp > Date.now() ? data : { expired: true };
  } catch { return null; }
}

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function page(title, msg) {
  return {
    statusCode: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;background:#f4f7ff;font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#0f172a;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px;">
<div style="background:#fff;border:1px solid rgba(15,23,42,.1);border-radius:16px;padding:32px;max-width:420px;width:100%;text-align:center;">
<div style="font-weight:800;color:#374269;margin-bottom:18px;">Lot<span style="color:#2859a8;">HQ</span></div>
<h1 style="font-size:20px;margin:0 0 10px;">${esc(title)}</h1><p style="color:#475569;line-height:1.55;margin:0 0 20px;">${esc(msg)}</p>
<a href="${SITE}/manager.html" style="display:inline-block;background:#1a6fff;color:#fff;text-decoration:none;padding:11px 22px;border-radius:9px;font-weight:600;">Go to Manager Portal</a></div></body></html>`,
  };
}

async function sbGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
  if (!res.ok) throw new Error(`Supabase GET ${path.split('?')[0]} ${res.status}: ${await res.text()}`);
  return res.json();
}

exports.handler = async (event) => {
  const link = readPlanLink(event.queryStringParameters?.t);
  if (!link) return page('Link not valid', 'This payment link is not valid. Ask LotHQ to send a new one.');
  if (link.expired) return page('Link expired', 'This payment link has expired. Ask LotHQ to send a new one.');
  try {
    const [p] = await sbGet(`properties?id=eq.${encodeURIComponent(link.p)}&select=*`);
    if (!p) return page('Property not found', 'This property is no longer on LotHQ.');
    if (p.plan_status === 'active' || p.plan_status === 'past_due') {
      return page('Already set up', `The LotHQ subscription for ${p.name} is already set up. To change the card, contact LotHQ.`);
    }
    const interval = p.plan_interval === 'year' ? 'year' : p.plan_interval === 'month' ? 'month' : null;
    const amount = Math.round(Number(p.plan_amount_cents) || 0);
    if (!interval || !(amount >= 50)) return page('Nothing to pay', 'There is no LotHQ subscription set up for this property. Contact LotHQ.');
    let email = null;
    if (p.manager_id) { const [u] = await sbGet(`users?id=eq.${p.manager_id}&select=email`); email = u?.email || null; }
    const metadata = { kind: 'lothq_plan', property_id: p.id, interval };
    const checkout = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      ...(p.plan_customer_id ? { customer: p.plan_customer_id } : email ? { customer_email: email } : {}),
      line_items: [{
        price_data: {
          currency: 'usd', unit_amount: amount, recurring: { interval },
          product_data: { name: `LotHQ subscription — ${p.name}`, description: `LotHQ parking software for ${p.name}, billed ${interval === 'year' ? 'yearly' : 'monthly'}` },
        },
        quantity: 1,
      }],
      metadata,
      subscription_data: { metadata },
      success_url: `${SITE}/manager.html?plan=started`,
      cancel_url: `${SITE}/manager.html`,
    });
    return { statusCode: 303, headers: { Location: checkout.url }, body: '' };
  } catch (err) {
    console.error('plan-pay error:', err);
    return page('Something went wrong', 'We couldn\'t open the payment page. Please try the link again in a minute.');
  }
};

exports.makePlanLink = makePlanLink;
