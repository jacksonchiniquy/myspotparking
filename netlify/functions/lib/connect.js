// Stripe Connect helpers: where a property's parking money goes, and LotHQ's cut.
//
// A property with no payout account keeps working the way it always has
// (payments land in LotHQ's own Stripe account). Once a payout account is
// linked, payments are made directly in that account ("direct charges"):
// the HOA / company / owner is the seller, Stripe takes its card fee from
// them, and LotHQ's fee is sent to LotHQ automatically. If the linked account
// isn't finished with Stripe's setup yet, payments are paused so money never
// lands in the wrong place.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Stripe's standard US card price, for the examples managers see (not for charging)
const CARD_PERCENT = 2.9;
const CARD_FIXED_CENTS = 30;

async function sb(method, path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, ...(method === 'GET' ? {} : { Prefer: 'return=representation' }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${method} ${path.split('?')[0]} ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

// LotHQ's fee (cents) on one payment, from the property's billing settings
function feeCents(property, amount) {
  const mode = (property && property.fee_mode) || 'none';
  let fee = 0;
  if (mode === 'percent' || mode === 'both') fee += Math.round(amount * (Number(property.fee_percent) || 0) / 100);
  if (mode === 'flat' || mode === 'both') fee += Math.round(Number(property.fee_flat_cents) || 0);
  return Math.max(0, Math.min(fee, amount));
}
// Same fee as a percent, for subscriptions (Stripe takes a percent on each renewal)
function feePercent(property, amount) {
  if (!(amount > 0)) return 0;
  return Math.min(100, Number((feeCents(property, amount) * 100 / amount).toFixed(2)));
}
function cardFeeEstimate(amount) {
  return Math.round(amount * CARD_PERCENT / 100) + CARD_FIXED_CENTS;
}

function isReady(acct) {
  return !!(acct && acct.details_submitted && acct.charges_enabled);
}

class PaymentsPaused extends Error {
  constructor() {
    super('This property is finishing its payment setup, so payments are paused for now. Please check with the property manager.');
    this.user = true;
  }
}

// Where this property's payments go.
//   { account: null }            → LotHQ's own account (not set up yet)
//   { account: 'acct_…', fee }   → the property's payout account
// Throws PaymentsPaused when a payout account is linked but not ready.
async function routeFor(property) {
  if (!property || !property.payout_account_id) return { account: null };
  const [acct] = await sb('GET', `payout_accounts?id=eq.${property.payout_account_id}&select=*`);
  if (!isReady(acct)) throw new PaymentsPaused();
  return { account: acct.stripe_account_id };
}

// Options for Stripe calls made inside a connected account
const opts = account => (account ? { stripeAccount: account } : undefined);

// Checkout additions that send LotHQ its fee (only for connected accounts)
function paymentFeeParams(property, account, amount) {
  if (!account) return {};
  const fee = feeCents(property, amount);
  return fee > 0 ? { payment_intent_data: { application_fee_amount: fee } } : {};
}
function subscriptionFeeParams(property, account, amount) {
  if (!account) return {};
  const pct = feePercent(property, amount);
  return pct > 0 ? { application_fee_percent: pct } : {};
}

// Which Stripe account a subscription lives in (null = LotHQ's own)
async function accountForSubscription(subscriptionId) {
  if (!subscriptionId) return null;
  const id = encodeURIComponent(subscriptionId);
  try {
    const [p] = await sb('GET', `permits?stripe_subscription_id=eq.${id}&stripe_account_id=not.is.null&select=stripe_account_id&limit=1`);
    if (p) return p.stripe_account_id;
    const [s] = await sb('GET', `property_units?spot_subscription_id=eq.${id}&stripe_account_id=not.is.null&select=stripe_account_id&limit=1`);
    if (s) return s.stripe_account_id;
  } catch (e) { console.error('accountForSubscription:', e.message); }
  return null;
}

// Stripe's billing page for a resident. Connected accounts get a simple
// billing page set up for them the first time.
async function portalUrl(stripe, customer, account, returnUrl) {
  try {
    return (await stripe.billingPortal.sessions.create({ customer, return_url: returnUrl }, opts(account))).url;
  } catch (e) {
    if (!account || !/configuration/i.test(e.message || '')) throw e;
    await stripe.billingPortal.configurations.create({
      business_profile: { headline: 'Manage your parking billing' },
      features: {
        invoice_history: { enabled: true },
        payment_method_update: { enabled: true },
        subscription_cancel: { enabled: true, mode: 'at_period_end' },
      },
      default_return_url: returnUrl,
    }, opts(account));
    return (await stripe.billingPortal.sessions.create({ customer, return_url: returnUrl }, opts(account))).url;
  }
}

// Copy a Stripe account's current status into payout_accounts
async function syncAccount(acct) {
  const due = (acct.requirements && (acct.requirements.currently_due || []).length) || 0;
  const past = (acct.requirements && (acct.requirements.past_due || []).length) || 0;
  const rows = await sb('PATCH', `payout_accounts?stripe_account_id=eq.${encodeURIComponent(acct.id)}`, {
    details_submitted: !!acct.details_submitted,
    charges_enabled: !!acct.charges_enabled,
    payouts_enabled: !!acct.payouts_enabled,
    needs_info: !!(due || past || (acct.details_submitted && !acct.charges_enabled)),
    updated_at: new Date().toISOString(),
  });
  return rows && rows[0];
}

// Subscription id on an invoice, for both older and newer Stripe formats
function invoiceSubscription(invoice) {
  const s = invoice && (invoice.subscription || invoice.parent?.subscription_details?.subscription);
  return s ? (typeof s === 'string' ? s : s.id) : null;
}

function statusOf(acct) {
  if (!acct) return 'none';
  if (isReady(acct) && !acct.needs_info) return 'ready';
  if (isReady(acct)) return 'ready_needs_info';
  return acct.details_submitted ? 'needs_info' : 'started';
}

module.exports = {
  feeCents, feePercent, cardFeeEstimate, routeFor, opts, paymentFeeParams, subscriptionFeeParams,
  accountForSubscription, portalUrl, syncAccount, invoiceSubscription, isReady, statusOf, PaymentsPaused,
  CARD_PERCENT, CARD_FIXED_CENTS,
};
