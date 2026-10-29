// payouts.js — a property's payout setup (Manager portal → property → Payouts)
//
// POST { action, propertyId, ... }   Authorization: Bearer <manager or admin login>
//   status                          who gets paid, payout account status, the
//                                   manager's other accounts, and LotHQ's fee
//   link   { payeeType, accountId } use an account the manager already set up
//   setup  { payeeType, label, accountId? }
//                                   start (or continue) Stripe's sign-up for a
//                                   payout account → { url } to send them to
//
// Stripe hosts the sign-up page (bank account, tax ID, identity), so LotHQ
// never sees or stores bank details.

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const connect = require('./lib/connect');
const { logActivity, userActor } = require('./lib/activity');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SITE = process.env.SITE_URL || 'https://myspotparking.com';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAYEE_TYPES = { hoa: 'HOA', management: 'Management company', owner: 'Property owner' };

function reply(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
class UserError extends Error { constructor(m, code = 400) { super(m); this.code = code; } }

async function sb(method, path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, ...(method === 'GET' ? {} : { Prefer: 'return=representation' }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    if (/payout_account|payee_type|fee_mode|42P01|42703/.test(text)) throw new UserError('Payouts aren\'t switched on yet. LotHQ needs to finish one setup step first.', 503);
    throw new Error(`Supabase ${method} ${path.split('?')[0]} ${res.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

// The caller must manage this property (or be a LotHQ admin)
async function authForProperty(event, propertyId) {
  const jwt = String(event.headers?.authorization || event.headers?.Authorization || '').replace(/^Bearer\s+/i, '');
  if (!jwt) throw new UserError('Please sign in again.', 401);
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${jwt}` } });
  if (!res.ok) throw new UserError('Please sign in again.', 401);
  const user = await res.json();
  if (!UUID_RE.test(String(propertyId || ''))) throw new UserError('Property not found.', 404);
  const [me] = await sb('GET', `users?id=eq.${user.id}&select=id,role`);
  const [property] = await sb('GET', `properties?id=eq.${propertyId}&select=*`);
  if (!property) throw new UserError('Property not found.', 404);
  const admin = me?.role === 'admin';
  // Payouts: main manager, admins, or an Owner on the property's team
  const team = require('./lib/team');
  if (!team.atLeast(await team.roleOn(property, me), 'owner')) throw new UserError('Only the property\'s owner can manage payouts.', 403);
  return { userId: user.id, email: user.email, admin, property };
}

const accountView = a => a && ({
  id: a.id, label: a.label || 'Payout account', payeeType: a.payee_type || null,
  last4: String(a.stripe_account_id || '').slice(-4), status: connect.statusOf(a),
});

// Ask Stripe for the latest status of an account that isn't fully ready yet
async function freshen(acct) {
  if (!acct || (connect.isReady(acct) && !acct.needs_info)) return acct;
  try { return (await connect.syncAccount(await stripe.accounts.retrieve(acct.stripe_account_id))) || acct; }
  catch (e) { console.error('Refreshing payout account failed:', e.message); return acct; }
}

async function accountLink(acct, propertyId) {
  const back = `${SITE}/manager.html?payouts=PARAM#property/${propertyId}/payouts`;
  const link = await stripe.accountLinks.create({
    account: acct.stripe_account_id, type: 'account_onboarding',
    refresh_url: back.replace('PARAM', 'refresh'), return_url: back.replace('PARAM', 'done'),
  });
  return link.url;
}

const actions = {
  async status(body, a) {
    const p = a.property;
    let acct = null;
    if (p.payout_account_id) [acct] = await sb('GET', `payout_accounts?id=eq.${p.payout_account_id}&select=*`);
    acct = await freshen(acct);
    const mine = await sb('GET', `payout_accounts?owner_id=eq.${a.userId}&select=*&order=created_at`);
    const amount = 500; // example: one $5.00 payment
    const fee = connect.feeCents(p, amount);
    const card = connect.cardFeeEstimate(amount);
    return {
      payeeType: p.payee_type || acct?.payee_type || null,
      account: accountView(acct),
      mine: mine.filter(m => m.id !== acct?.id).map(accountView),
      fee: { mode: p.fee_mode || 'none', percent: Number(p.fee_percent) || 0, flatCents: Number(p.fee_flat_cents) || 0 },
      example: { amount, card, fee, net: Math.max(0, amount - card - fee) },
      stripeReady: !!process.env.STRIPE_SECRET_KEY,
    };
  },

  async link({ payeeType, accountId }, a) {
    if (!PAYEE_TYPES[payeeType]) throw new UserError('Choose who receives payments for this property.');
    if (!UUID_RE.test(String(accountId || ''))) throw new UserError('Choose an account.');
    const [acct] = await sb('GET', `payout_accounts?id=eq.${accountId}&select=*`);
    if (!acct || (!a.admin && acct.owner_id !== a.userId)) throw new UserError('That account wasn\'t found.', 404);
    await sb('PATCH', `properties?id=eq.${a.property.id}`, { payout_account_id: acct.id, payee_type: payeeType });
    await logActivity({ ...(await userActor(a.userId)), actorRole: a.admin ? 'admin' : 'manager', portal: a.admin ? 'admin' : 'manager',
      action: 'billing.payouts_linked', propertyId: a.property.id, target: a.property.name,
      summary: `Payouts for ${a.property.name} now go to ${acct.label || 'payout account'} (${PAYEE_TYPES[payeeType]})` });
    return actions.status({}, { ...a, property: { ...a.property, payout_account_id: acct.id, payee_type: payeeType } });
  },

  async setup({ payeeType, label, accountId }, a) {
    if (!PAYEE_TYPES[payeeType]) throw new UserError('Choose who receives payments for this property.');
    let acct = null;
    if (accountId) {
      if (!UUID_RE.test(String(accountId))) throw new UserError('Account not found.', 404);
      [acct] = await sb('GET', `payout_accounts?id=eq.${accountId}&select=*`);
      if (!acct || (!a.admin && acct.owner_id !== a.userId)) throw new UserError('Account not found.', 404);
    } else {
      const name = String(label || '').trim().slice(0, 120);
      if (name.length < 2) throw new UserError('Enter the name of the HOA, company or owner who gets paid.');
      const params = {
        country: 'US',
        business_profile: { name },
        metadata: { lothq_property: a.property.id, payee_type: payeeType, set_up_by: a.email || a.userId },
      };
      let created;
      try {
        // "Stripe handles pricing": the account pays Stripe's fees, Stripe covers
        // account losses, and the owner gets the full Stripe Dashboard
        created = await stripe.accounts.create({
          ...params,
          controller: { fees: { payer: 'account' }, losses: { payments: 'stripe' }, stripe_dashboard: { type: 'full' } },
        });
      } catch (e) {
        if (/signed up for Connect|platform profile|connect/i.test(e.message || '') && !/controller/i.test(e.message || '')) {
          console.error('Stripe Connect not ready:', e.message);
          throw new UserError(a.admin ? `Stripe says: ${e.message}` : 'LotHQ is finishing its payment setup. Please try again later.', 503);
        }
        if (!/controller/i.test(e.message || '')) throw e;
        created = await stripe.accounts.create({ ...params, type: 'standard' }); // same setup, older style
      }
      [acct] = await sb('POST', 'payout_accounts', {
        stripe_account_id: created.id, owner_id: a.userId, label: name, payee_type: payeeType,
      });
      await logActivity({ ...(await userActor(a.userId)), actorRole: a.admin ? 'admin' : 'manager', portal: a.admin ? 'admin' : 'manager',
        action: 'billing.payouts_started', propertyId: a.property.id, target: a.property.name,
        summary: `Started payout setup for ${a.property.name}: ${name} (${PAYEE_TYPES[payeeType]})` });
    }
    await sb('PATCH', `properties?id=eq.${a.property.id}`, { payout_account_id: acct.id, payee_type: payeeType });
    return { url: await accountLink(acct, a.property.id) };
  },
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed' });
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return reply(400, { error: 'Invalid request' }); }
  const fn = actions[body.action];
  if (!fn) return reply(400, { error: 'Unknown action' });
  try {
    if (!process.env.STRIPE_SECRET_KEY) throw new UserError('Payments are not set up yet.', 503);
    const a = await authForProperty(event, body.propertyId);
    return reply(200, await fn(body, a));
  } catch (e) {
    if (e instanceof UserError) return reply(e.code, { error: e.message });
    console.error('payouts error:', e);
    return reply(500, { error: 'Something went wrong. Please try again.' });
  }
};
