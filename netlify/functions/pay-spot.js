// pay-spot.js — the "Pay & Add Spot" link in the manager's payment email.
// GET ?t=<signed link> → opens a fresh Stripe checkout for that one spot.
// (Stripe checkout pages expire after a day, so the email links here instead.)

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createSpotCheckout, spotProblem, readPayLink, sbGet, SITE } = require('./lib/spot-checkout');

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function page(title, msg) {
  return {
    statusCode: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;background:#f4f7ff;font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#0f172a;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px;">
<div style="background:#fff;border:1px solid rgba(15,23,42,.1);border-radius:16px;padding:32px;max-width:420px;width:100%;text-align:center;">
<div style="font-weight:800;color:#2859a8;margin-bottom:18px;">LotHQ <span style="font-size:11px;letter-spacing:.14em;">PARKING</span></div>
<h1 style="font-size:20px;margin:0 0 10px;">${esc(title)}</h1><p style="color:#475569;line-height:1.55;margin:0 0 20px;">${esc(msg)}</p>
<a href="${SITE}/unit.html" style="display:inline-block;background:#1a6fff;color:#fff;text-decoration:none;padding:11px 22px;border-radius:9px;font-weight:600;">Go to My Unit</a></div></body></html>`,
  };
}

exports.handler = async (event) => {
  const link = readPayLink(event.queryStringParameters?.t);
  if (!link) return page('Link not valid', 'This payment link is not valid. Ask your property manager to send a new one.');
  if (link.expired) return page('Link expired', 'This payment link has expired. Ask your property manager to send a new one.');
  try {
    const [slot] = await sbGet(`property_units?id=eq.${encodeURIComponent(link.s)}&select=*,properties(*)`);
    const problem = spotProblem(slot);
    if (problem) return page(slot?.spot_paid ? 'Already paid' : 'Nothing to pay', problem);
    const unitRows = await sbGet(`property_units?property_id=eq.${encodeURIComponent(slot.property_id)}&unit_number=eq.${encodeURIComponent(slot.unit_number)}&select=invite_used,unit_password`);
    if (!unitRows.some(r => r.invite_used || r.unit_password)) {
      return page('Finish signing up first', 'Your unit isn\'t set up yet. Use the invite from your property manager to sign up — you can add paid spots during sign-up.');
    }
    const checkout = await createSpotCheckout(stripe, {
      slot, property: slot.properties || {}, email: slot.tenant_email || null,
      successUrl: `${SITE}/unit.html?spot_added=1`, cancelUrl: `${SITE}/unit.html`,
    });
    return { statusCode: 303, headers: { Location: checkout.url }, body: '' };
  } catch (err) {
    if (err.user) return page('Can\'t take payment yet', err.message);
    console.error('pay-spot error:', err);
    return page('Something went wrong', 'We couldn\'t open the payment page. Please try the link again in a minute.');
  }
};
