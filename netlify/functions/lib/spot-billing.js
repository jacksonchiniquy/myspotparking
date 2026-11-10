// Keeps a tenant's live card billing (a Stripe subscription) in step with
// their spots in LotHQ: the price (when a manager chooses to change it) and
// each spot's discount (a Stripe coupon on the subscription).
//
// A subscription can cover several spots (picked together at sign-up) or one
// spot (added later). Each spot's discount is its own coupon, worked out as
// that spot's share of the subscription's price, so the tenant's Stripe
// receipts show it.

const { spotMonthlyCents, cycleCents, discountActive, discountLabel } = require('./spot-pricing');
const connect = require('./connect');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const STANDARD_PCT = { 1: 0, 3: 5, 12: 15 };
const CYCLE_BY_MONTHS = { 1: 'monthly', 3: 'quarterly', 12: 'yearly' };

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
const q = encodeURIComponent;

const itemMonths = item => {
  const r = item?.price?.recurring || {};
  return r.interval === 'year' ? 12 * (r.interval_count || 1) : (r.interval_count || 1);
};
const addMonths = (d, n) => { const x = new Date(d); x.setMonth(x.getMonth() + n); return x; };

// This spot's discount in cents on one payment of the subscription
function spotShareCents(spot, spots, property, amount, months) {
  if (!discountActive(spot)) return 0;
  const total = spots.reduce((t, s) => t + spotMonthlyCents(s, property), 0);
  const mine = spotMonthlyCents(spot, property);
  if (!(total > 0) || !(mine > 0)) return 0;
  const portion = Math.round(amount * mine / total);
  const v = Number(spot.discount_value);
  const off = spot.discount_type === 'pct' ? Math.round(portion * Math.min(100, v) / 100) : Math.round(v * 100 * months);
  return Math.max(0, Math.min(off, portion));
}

// How long a new coupon should last, and when the discount runs out
function couponDuration(spot, now = new Date()) {
  if (spot.discount_duration === 'once') return { duration: 'once' };
  if (spot.discount_duration === 'months') {
    const fresh = !spot.discount_ends_at;
    const end = fresh ? addMonths(now, Math.max(1, Number(spot.discount_months) || 1)) : new Date(spot.discount_ends_at);
    const left = fresh ? Math.max(1, Number(spot.discount_months) || 1) : Math.max(1, Math.ceil((end - now) / (30.44 * 864e5) - 0.1));
    return { duration: 'repeating', duration_in_months: left, endsAt: end };
  }
  return { duration: 'forever' };
}

async function newCoupon(stripe, account, spot, cents, property) {
  const d = couponDuration(spot);
  const coupon = await stripe.coupons.create({
    amount_off: cents, currency: 'usd', duration: d.duration,
    ...(d.duration_in_months ? { duration_in_months: d.duration_in_months } : {}),
    name: `${spot.slot_label || 'Spot'} · ${discountLabel(spot)}`.slice(0, 40),
    metadata: { kind: 'spot_discount', slot_id: spot.id, property_id: property?.id || spot.property_id },
  }, connect.opts(account));
  return { coupon, endsAt: d.endsAt || null };
}

// Bring one subscription in line with its spots.
//   applyPrice      also reset the price to the spots' current prices
//   changedSpotIds  spots whose discount the manager just changed (always get a fresh coupon)
//   couponFromCheckout  coupon already on it from checkout, with each spot's share
async function syncSubscription(stripe, subscriptionId, opt = {}) {
  const spots = await sb('GET', `property_units?spot_subscription_id=eq.${q(subscriptionId)}&select=*`);
  if (!spots.length) return { ok: false, reason: 'no spots' };
  const [property] = await sb('GET', `properties?id=eq.${spots[0].property_id}&select=*`);
  const account = spots.find(s => s.stripe_account_id)?.stripe_account_id || null;
  const so = connect.opts(account);
  const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ['discounts'] }, so);
  if (!sub || ['canceled', 'incomplete_expired'].includes(sub.status)) return { ok: false, reason: 'not active' };
  const item = sub.items?.data?.[0];
  if (!item) return { ok: false, reason: 'no item' };
  const months = itemMonths(item);
  const update = {};
  const result = { ok: true, oldCents: item.price.unit_amount, newCents: item.price.unit_amount, months };

  // ── Price ──
  let amount = item.price.unit_amount;
  if (opt.applyPrice) {
    const monthly = spots.reduce((t, s) => t + spotMonthlyCents(s, property), 0);
    const pct = spots.find(s => s.cycle_pct != null)?.cycle_pct ?? STANDARD_PCT[months] ?? 0;
    const cycle = CYCLE_BY_MONTHS[months] || 'monthly';
    const next = monthly > 0 ? cycleCents(monthly, cycle, pct) : 0;
    if (next >= 50 && next !== amount) {
      update.items = [{ id: item.id, price_data: { currency: 'usd', product: typeof item.price.product === 'string' ? item.price.product : item.price.product.id,
        unit_amount: next, recurring: { interval: item.price.recurring.interval, interval_count: item.price.recurring.interval_count } } }];
      update.proration_behavior = 'none';
      amount = next; result.newCents = next;
    }
  }

  // ── Discounts ──
  const changed = new Set(opt.changedSpotIds || []);
  const onSub = (sub.discounts || []).map(d => (typeof d === 'string' ? { id: d } : d)).filter(Boolean);
  const onSubByCoupon = new Map(onSub.filter(d => d.coupon).map(d => [d.coupon.id, d]));
  const ourCoupon = d => d.coupon?.metadata?.kind === 'spot_discount';
  const wants = spots.map(s => ({ s, share: spotShareCents(s, spots, property, amount, months) }));
  // A coupon can be kept only if every spot that uses it still wants exactly that
  const keep = new Set();
  const groups = new Map();
  wants.forEach(w => { if (w.s.discount_coupon_id) (groups.get(w.s.discount_coupon_id) || groups.set(w.s.discount_coupon_id, []).get(w.s.discount_coupon_id)).push(w); });
  for (const [cid, ws] of groups) {
    const ok = ws.every(w => w.share > 0 && !changed.has(w.s.id) && Number(w.s.discount_coupon_cents) === w.share);
    if (ok) keep.add(cid);
  }
  const rows = []; // property_units updates
  const next = [];
  // Keep discounts that aren't LotHQ spot coupons (e.g. added by hand in Stripe)
  onSub.forEach(d => { if (d.id && !ourCoupon(d) && d.coupon) next.push({ discount: d.id }); });
  for (const cid of keep) { const d = onSubByCoupon.get(cid); if (d) next.push({ discount: d.id }); }
  for (const w of wants) {
    const s = w.s;
    if (s.discount_coupon_id && keep.has(s.discount_coupon_id)) {
      // Kept, but Stripe already used it up (one-time / ran out): the discount is over
      if (!onSubByCoupon.has(s.discount_coupon_id) && s.discount_duration !== 'forever' && !changed.has(s.id)) {
        rows.push([s.id, { discount_ends_at: s.discount_ends_at && new Date(s.discount_ends_at) < new Date() ? s.discount_ends_at : new Date().toISOString() }]);
      }
      continue;
    }
    if (!(w.share > 0)) {
      if (s.discount_coupon_id) rows.push([s.id, { discount_coupon_id: null, discount_coupon_cents: null }]);
      continue;
    }
    // Was on before, Stripe has since used it up, and nobody changed it: don't give it again
    if (s.discount_coupon_id && !changed.has(s.id) && !onSubByCoupon.has(s.discount_coupon_id) && s.discount_duration !== 'forever'
      && Number(s.discount_coupon_cents) === w.share) {
      rows.push([s.id, { discount_ends_at: new Date().toISOString() }]);
      continue;
    }
    const { coupon, endsAt } = await newCoupon(stripe, account, s, w.share, property);
    next.push({ coupon: coupon.id });
    rows.push([s.id, { discount_coupon_id: coupon.id, discount_coupon_cents: w.share,
      discount_ends_at: s.discount_duration === 'once' ? new Date((sub.current_period_end || item.current_period_end || Date.now() / 1000) * 1000).toISOString()
        : endsAt ? new Date(endsAt).toISOString() : null }]);
  }
  const before = onSub.map(d => d.id).sort().join();
  const after = next.filter(d => d.discount).map(d => d.discount).sort().join();
  if (next.some(d => d.coupon) || before !== after) update.discounts = next.length ? next : '';

  if (Object.keys(update).length) await stripe.subscriptions.update(subscriptionId, update, so);
  for (const [id, patch] of rows) await sb('PATCH', `property_units?id=eq.${id}`, patch);
  result.changedDiscounts = !!update.discounts;
  result.changedPrice = !!update.items;
  return result;
}

// A combined coupon for a new checkout (sign-up or added spot). Checkout takes one
// coupon, so this works when every discounted spot has the same duration;
// otherwise returns null and the discounts are added right after payment.
async function checkoutCoupon(stripe, account, spots, property, amount, months) {
  const disc = spots.filter(s => discountActive(s));
  if (!disc.length) return null;
  const key = s => `${s.discount_duration || 'forever'}:${s.discount_duration === 'months' ? s.discount_months : ''}`;
  if (new Set(disc.map(key)).size > 1) return null;
  const shares = {};
  let total = 0;
  for (const s of disc) { const c = spotShareCents(s, spots, property, amount, months); if (c > 0) { shares[s.id] = c; total += c; } }
  if (!(total > 0)) return null;
  total = Math.min(total, amount);
  const d = couponDuration(disc[0]);
  const coupon = await stripe.coupons.create({
    amount_off: total, currency: 'usd', duration: d.duration,
    ...(d.duration_in_months ? { duration_in_months: d.duration_in_months } : {}),
    name: (disc.length === 1 ? `${disc[0].slot_label || 'Spot'} · ${discountLabel(disc[0])}` : 'Parking discount').slice(0, 40),
    metadata: { kind: 'spot_discount', property_id: property?.id || '' },
  }, connect.opts(account));
  return { coupon: coupon.id, shares };
}

// After checkout: remember the coupon on each spot, then add anything still missing
async function afterCheckout(stripe, subscriptionId, meta = {}) {
  if (!subscriptionId) return;
  try {
    if (meta.discount_coupon) {
      const shares = Object.fromEntries(String(meta.discount_shares || '').split(',').filter(Boolean).map(x => x.split(':')));
      for (const [id, cents] of Object.entries(shares)) {
        const [s] = await sb('GET', `property_units?id=eq.${q(id)}&select=*`);
        if (!s) continue;
        const d = couponDuration({ ...s, discount_ends_at: null });
        await sb('PATCH', `property_units?id=eq.${q(id)}`, { discount_coupon_id: meta.discount_coupon, discount_coupon_cents: Number(cents),
          discount_ends_at: s.discount_duration === 'once' ? new Date().toISOString() : d.endsAt ? d.endsAt.toISOString() : null });
      }
    }
    await syncSubscription(stripe, subscriptionId, {});
  } catch (e) { console.error('Applying spot discounts after checkout failed:', e.message); }
}

// For Stripe metadata (500 characters max): "spotId:cents,spotId:cents"
const sharesMeta = shares => Object.entries(shares || {}).map(([id, c]) => `${id}:${c}`).join(',').slice(0, 500);

module.exports = { sharesMeta, syncSubscription, checkoutCoupon, afterCheckout, spotShareCents, itemMonths, STANDARD_PCT, sb };
