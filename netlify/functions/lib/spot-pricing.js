// Shared spot pricing for unit sign-up (invite-lookup, create-permit-checkout,
// create-free-permit). One place, so the page and the charge always agree.
//
// Prices:
//   • Each spot's own monthly price (property_units.monthly_amount, in DOLLARS)
//   • If a paid spot has no price of its own, the property's
//     "Default Monthly Rate" (properties.monthly_rate, also in DOLLARS)
//   • Quarterly = 3 months less 5%, Yearly = 12 months less 15%
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

function cycleCents(monthlyCents, cycle) {
  const c = CYCLES[cycle] || CYCLES.monthly;
  return Math.round(monthlyCents * c.months * (1 - c.discount));
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
  return {
    id: s.id, slot_label: s.slot_label, slot_type: s.slot_type,
    billing_type: prepaid ? 'prepaid' : isPaid(s) ? 'monthly' : 'free',
    monthly_cents: isPaid(s) && !prepaid ? spotMonthlyCents(s, property) : 0,
  };
}

// Which paid spots the resident picked (only real paid spots of this unit count)
function chosenPaidSpots(spots, spotIds) {
  const want = new Set(Array.isArray(spotIds) ? spotIds.map(String) : []);
  return spots.filter(s => isPaid(s) && !s.spot_paid && want.has(String(s.id)));
}

module.exports = { CYCLES, isPaid, spotMonthlyCents, cycleCents, unitSpots, publicSpot, chosenPaidSpots };
