// Shared spot pricing for unit sign-up (invite-lookup, create-permit-checkout,
// create-free-permit). One place, so the page and the charge always agree.
//
// Prices:
//   • Each spot's own monthly price (property_units.monthly_amount, in DOLLARS)
//   • If a paid spot has no price of its own, the property's
//     "Default Monthly Rate" (properties.monthly_rate, also in DOLLARS)
//   • Quarterly / yearly savings: the property's own (properties.pay_ahead),
//     standard 5% quarterly and 15% yearly
//   • A spot's discount (discount_*) comes off through a Stripe coupon
// Everything returned here is in CENTS (what Stripe uses).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const CYCLES = {
  monthly:   { months: 1,  discount: 0 },
  quarterly: { months: 3,  discount: 0.05 },
  yearly:    { months: 12, discount: 0.15 },
};

const isPaid = s => s && s.billing_type === 'monthly';

function spotMonthlyCents(spot, property) {
  const own = Math.round(Number(spot?.monthly_amount) * 100);
  if (own > 0) return own;
  const def = Math.round(Number(property?.monthly_rate) * 100);
  return def > 0 ? def : 0;
}

// The billing cycles a property offers, with its own pay-ahead savings.
// properties.pay_ahead = {"monthly":{"on":true},"quarterly":{"on":true,"pct":5},"yearly":{"on":true,"pct":15}}
// Missing = the standard 5% quarterly / 15% yearly, all offered.
function cyclesFor(property) {
  const pa = (property && typeof property.pay_ahead === 'object' && property.pay_ahead) || {};
  const out = {};
  for (const [id, c] of Object.entries(CYCLES)) {
    const set = pa[id] || {};
    const pct = id === 'monthly' ? 0 : Math.min(50, Math.max(0, Number(set.pct ?? c.discount * 100) || 0));
    out[id] = { id, months: c.months, pct, on: set.on !== false };
  }
  if (!Object.values(out).some(c => c.on)) out.monthly.on = true; // always offer something
  return out;
}

// Price for one billing cycle. `pct` = savings percent (defaults to the standard).
function cycleCents(monthlyCents, cycle, pct) {
  const c = CYCLES[cycle] || CYCLES.monthly;
  const save = pct == null ? c.discount : Number(pct) / 100;
  return Math.round(monthlyCents * c.months * (1 - save));
}

// ── Discounts on a spot ──
// Active = set, and not run out yet
function discountActive(s, now = new Date()) {
  return !!(s && (s.discount_type === 'pct' || s.discount_type === 'amount') && Number(s.discount_value) > 0
    && (!s.discount_ends_at || new Date(s.discount_ends_at) > now));
}
// Short label, e.g. "20% off for 3 months", "$10 off a month", "20% off next payment"
function discountLabel(s) {
  if (!discountActive(s)) return '';
  const v = Number(s.discount_value);
  const what = s.discount_type === 'pct' ? `${+v.toFixed(2)}% off` : `$${v % 1 ? v.toFixed(2) : v} off`;
  if (s.discount_duration === 'once') return `${what} the next payment`;
  if (s.discount_duration === 'months') return `${what} for ${s.discount_months} month${s.discount_months == 1 ? '' : 's'}`;
  return s.discount_type === 'pct' ? what : `${what} a month`;
}
// Discount in cents on one month of this spot's price
function discountMonthlyCents(s, monthlyCents) {
  if (!discountActive(s)) return 0;
  const v = Number(s.discount_value);
  const off = s.discount_type === 'pct' ? Math.round(monthlyCents * Math.min(100, v) / 100) : Math.round(v * 100);
  return Math.min(off, monthlyCents);
}

// All spots that belong to the same unit as this invite spot (invite spot first)
async function unitSpots(inviteSpot) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/property_units?property_id=eq.${encodeURIComponent(inviteSpot.property_id)}` +
    `&unit_number=eq.${encodeURIComponent(inviteSpot.unit_number)}&select=*&order=slot_label`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
  );
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const rows = await res.json();
  return [inviteSpot, ...rows.filter(r => r.id !== inviteSpot.id)];
}

// What the sign-up page may see about each spot
// A paid spot that's already paid for (card or outside billing) is shown as
// 'prepaid' and is never charged again at sign-up.
function publicSpot(s, property) {
  const prepaid = isPaid(s) && !!s.spot_paid;
  const monthly = isPaid(s) && !prepaid ? spotMonthlyCents(s, property) : 0;
  const off = monthly ? discountMonthlyCents(s, monthly) : 0;
  return {
    id: s.id, slot_label: s.slot_label, slot_type: s.slot_type,
    billing_type: prepaid ? 'prepaid' : isPaid(s) ? 'monthly' : 'free',
    monthly_cents: monthly,
    ...(off ? { discount: { label: discountLabel(s), monthly_off_cents: off, duration: s.discount_duration || 'forever' } } : {}),
  };
}

// Which paid spots the resident picked (only real paid spots of this unit count)
function chosenPaidSpots(spots, spotIds) {
  const want = new Set(Array.isArray(spotIds) ? spotIds.map(String) : []);
  return spots.filter(s => isPaid(s) && !s.spot_paid && want.has(String(s.id)));
}

module.exports = { CYCLES, isPaid, spotMonthlyCents, cycleCents, cyclesFor, unitSpots, publicSpot, chosenPaidSpots,
  discountActive, discountLabel, discountMonthlyCents };
