// refund-session.js — refund a Pay to Park payment (Manager portal → Pay to Park → Refund)
//
// POST { sessionId, amountCents?, endNow, reason? }   Authorization: Bearer <manager or admin login>
//
// Who can refund: the property's Owner / Admin or Manager (or a LotHQ admin).
// Leasing agents and view-only users can't.
//
// The refund is made in whichever Stripe account was paid: the property's payout
// account, or LotHQ's own if the property had no payout account. When LotHQ took
// a fee on the payment, its share is given back too (in proportion).
// Stripe's own processing fee is not returned by Stripe.

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { sb } = require('./lib/parking');
const team = require('./lib/team');
const { logActivity, userActor, money } = require('./lib/activity');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TZ = 'America/Denver';

function reply(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
class UserError extends Error { constructor(m, code = 400) { super(m); this.code = code; } }

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDay = iso => new Date(iso).toLocaleString('en-US', { timeZone: TZ, month: 'short', day: 'numeric' });
const fmtDuration = m => m >= 480 ? 'Full Day' : m >= 60 ? `${m / 60} Hour${m > 60 ? 's' : ''}` : `${m} Min`;

async function signedInUser(event) {
  const jwt = String(event.headers?.authorization || event.headers?.Authorization || '').replace(/^Bearer\s+/i, '');
  if (!jwt) throw new UserError('Please sign in again.', 401);
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${jwt}` } });
  if (!res.ok) throw new UserError('Please sign in again.', 401);
  return res.json();
}

async function emailDriver(row, property, cents, ended) {
  const { sendRaw, logoHeader } = require('./send-email');
  const name = property?.name || 'the property';
  const amt = money(cents);
  const what = `plate ${row.plate} (${fmtDay(row.started_at)}, ${fmtDuration(Number(row.duration_minutes) || 0)})`;
  await sendRaw({
    to: row.email,
    subject: `Refund of ${amt} — ${row.plate} at ${name}`,
    html: `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 16px;color:#0f172a;background:#ffffff;">
  ${logoHeader('#059669')}
  <h2 style="margin:0 0 8px;">Your refund is on its way</h2>
  <p style="color:#475569;margin:0 0 12px;line-height:1.6;">${esc(name)} refunded <b>${amt}</b> for ${esc(what)}.</p>
  <p style="color:#475569;margin:0 0 12px;line-height:1.6;">It should appear on your card in 5–10 business days.</p>
  ${ended ? '<p style="color:#475569;margin:0 0 12px;line-height:1.6;">This parking session has ended. If you\'re still parked, please start a new payment.</p>' : ''}
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;">
  <p style="color:#94a3b8;font-size:11px;text-align:center;">© ${new Date().getFullYear()} LotHQ · Provo, UT</p>
</body></html>`,
    text: `Your refund is on its way\n\n${name} refunded ${amt} for ${what}.\nIt should appear on your card in 5-10 business days.` +
      (ended ? `\n\nThis parking session has ended. If you're still parked, please start a new payment.` : ''),
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed' });
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return reply(400, { error: 'Invalid request' }); }

  try {
    const user = await signedInUser(event);
    const sessionId = String(body.sessionId || '');
    if (!UUID_RE.test(sessionId)) throw new UserError('Payment not found.', 404);

    const [row] = await sb('GET', `parking_sessions?id=eq.${sessionId}&select=*`);
    if (!row) throw new UserError('Payment not found.', 404);
    if (!('refunded_cents' in row)) throw new UserError('Refunds aren\'t switched on yet. LotHQ needs to finish one setup step first.', 503);

    const [property] = await sb('GET', `properties?id=eq.${row.property_id}&select=*`);
    const [me] = await sb('GET', `users?id=eq.${user.id}&select=id,role`);
    if (!team.atLeast(await team.roleOn(property, me), 'manager')) throw new UserError('Only the property\'s owners and managers can give refunds.', 403);

    if (!row.stripe_session_id || ['pending', 'canceled', 'cancelled', 'failed'].includes(row.status)) throw new UserError('This session was never paid, so there\'s nothing to refund.');
    const paid = Math.round(Number(row.amount_paid) || 0);
    const already = Math.round(Number(row.refunded_cents) || 0);
    const left = paid - already;
    if (left <= 0) throw new UserError('This payment has already been fully refunded.');

    let cents = body.amountCents == null ? left : Math.round(Number(body.amountCents));
    if (!(cents >= 1)) throw new UserError('Enter an amount to refund.');
    if (cents > left) throw new UserError(`You can refund at most ${money(left)} on this payment.`);
    const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : '';
    const endNow = !!body.endNow;

    // Find the payment in the Stripe account that was paid, then refund it there
    const account = row.stripe_account_id || null;
    const sOpts = account ? { stripeAccount: account } : {};
    const checkout = await stripe.checkout.sessions.retrieve(row.stripe_session_id, {}, account ? { stripeAccount: account } : undefined);
    if (checkout.metadata?.kind !== 'parking_session' || checkout.metadata?.property_id !== row.property_id) throw new UserError('Payment not found.', 404);
    const pi = typeof checkout.payment_intent === 'string' ? checkout.payment_intent : checkout.payment_intent?.id;
    if (!pi) throw new UserError('Stripe has no payment for this session.');

    const refund = await stripe.refunds.create({
      payment_intent: pi,
      amount: cents,
      reason: 'requested_by_customer',
      ...(account ? { refund_application_fee: true } : {}), // LotHQ gives its share back
      metadata: { kind: 'parking_session_refund', session_id: row.id, property_id: row.property_id, by: user.id },
    }, { ...sOpts, idempotencyKey: `p2p-refund-${row.id}-${already}-${cents}` });

    const actor = await userActor(user.id);
    const now = new Date().toISOString();
    const patch = {
      refunded_cents: already + cents, refunded_at: now, refunded_by: user.id,
      refunded_by_name: actor.actorName || user.email || null, refund_reason: reason || null,
    };
    if (endNow && row.status === 'active') { patch.status = 'refunded'; if (new Date(row.expires_at) > new Date()) patch.expires_at = now; }
    else if (already + cents >= paid && row.status !== 'active') patch.status = 'refunded';
    const [saved] = await sb('PATCH', `parking_sessions?id=eq.${row.id}&refunded_cents=eq.${already}`, patch);

    await logActivity({
      ...actor, portal: 'manager', action: 'parking_session.refunded', propertyId: row.property_id, target: row.plate,
      summary: `Refunded ${money(cents)} for plate ${row.plate} (Pay to Park)${reason ? ` — "${reason}"` : ''}${patch.status === 'refunded' && endNow ? ', parking time ended' : ''}`,
      details: { session_id: row.id, refund_id: refund.id, amount_cents: cents, ended: !!(endNow && row.status === 'active') },
    });

    let emailed = false;
    if (row.email) {
      try { await emailDriver(row, property, cents, !!(endNow && row.status === 'active')); emailed = true; }
      catch (e) { console.error('Refund email failed:', e.message); }
    }

    return reply(200, { ok: true, refundedCents: cents, session: saved || { ...row, ...patch }, emailed });
  } catch (err) {
    if (err instanceof UserError) return reply(err.code, { error: err.message });
    const sm = err && err.raw?.message;
    console.error('refund-session error:', sm || err.message, err);
    if (err?.type === 'StripeInvalidRequestError' && sm) return reply(400, { error: 'Stripe said: ' + sm });
    return reply(500, { error: 'The refund didn\'t go through. Please try again.' });
  }
};
