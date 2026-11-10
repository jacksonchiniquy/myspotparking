// Pay to Park promo codes: look one up, check it can be used, and work out the price.
const { sb } = require('./parking');

const TZ = 'America/Denver';
const cleanCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 20);

async function findPromo(propertyId, code) {
  const c = cleanCode(code);
  if (c.length < 3) return null;
  try {
    const rows = await sb('GET', `promo_codes?property_id=eq.${propertyId}&code=eq.${encodeURIComponent(c)}&select=*&limit=1`);
    return rows[0] || null;
  } catch (e) {
    if (/promo_codes|42P01/.test(e.message)) return null; // before the discounts database step
    throw e;
  }
}

// Price after the code, in cents. Under Stripe's 50¢ minimum = free.
function priceWith(promo, amount) {
  if (!promo) return amount;
  let p = amount;
  if (promo.kind === 'free') p = 0;
  else if (promo.kind === 'pct') p = Math.round(amount * (1 - Math.min(100, Number(promo.value)) / 100));
  else if (promo.kind === 'amount') p = amount - Math.round(Number(promo.value) * 100);
  p = Math.max(0, p);
  return p < 50 ? 0 : p;
}

// Start of today in Denver, as an ISO time
function todayStart() {
  const now = new Date();
  const local = new Date(now.toLocaleString('en-US', { timeZone: TZ }));
  const offset = now - local;
  local.setHours(0, 0, 0, 0);
  return new Date(local.getTime() + offset).toISOString();
}

// '' if the code can be used for this rate and plate, otherwise why not
async function promoProblem(promo, rate, plate) {
  if (!promo || !promo.active) return 'That code isn\'t valid here.';
  if (promo.ends_at && new Date(promo.ends_at) <= new Date()) return 'That code has ended.';
  if (promo.max_uses != null && promo.uses >= promo.max_uses) return 'That code has been used up.';
  if (rate && Array.isArray(promo.rate_ids) && promo.rate_ids.length && !promo.rate_ids.includes(String(rate.id || rate.name)))
    return `That code doesn't work on ${rate.name || 'this option'}.`;
  if (promo.once_per_day && plate) {
    const used = await sb('GET', `parking_sessions?property_id=eq.${promo.property_id}&promo_code=eq.${encodeURIComponent(promo.code)}&plate=eq.${encodeURIComponent(plate)}&status=in.(active,expired,refunded)&started_at=gte.${encodeURIComponent(todayStart())}&select=id&limit=1`);
    if (used.length) return 'That code was already used for this plate today.';
  }
  return '';
}

const promoLabel = p => !p ? '' : p.kind === 'free' ? 'Free parking' : p.kind === 'pct' ? `${+Number(p.value).toFixed(2)}% off` : `$${Number(p.value).toFixed(2)} off`;

// Count one use (only if uses are left). Never throws.
async function useIt(promoId) {
  try {
    const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/promo_use`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: process.env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}` },
      body: JSON.stringify({ p_id: promoId }),
    });
    return r.ok ? (await r.json()) === true : false;
  } catch (e) { console.error('promo_use failed:', e.message); return false; }
}

module.exports = { cleanCode, findPromo, priceWith, promoProblem, promoLabel, useIt };
