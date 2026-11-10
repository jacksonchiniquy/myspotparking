// park-lookup.js — finds a Pay to Park property for pay.html and park.html
//   POST { code: 'TPP-4821' }  or  { id: '<property id>' }
// Returns only what a driver needs to see: name, address, code, stall setting
// and the parking options. Nothing else about the property is shared.

const { ratesFor, sb } = require('./lib/parking');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function reply(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) };
}

// "tpp 4821", "TPP4821", "tpp-4821" → "TPP-4821"
function normalizeCode(raw) {
  const s = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const m = s.match(/^([A-Z]{3})([0-9]{4})$/);
  return m ? `${m[1]}-${m[2]}` : null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed' });
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return reply(400, { error: 'Invalid request' }); }

  // Check a promo code: { id, promo: 'GUEST50' } → the price of each option with it
  if (body.promo !== undefined) {
    if (!UUID_RE.test(String(body.id || ''))) return reply(404, { error: 'Property not found.' });
    try {
      const promo = require('./lib/promo');
      const [p] = await sb('GET', `properties?id=eq.${body.id}&select=*`);
      if (!p) return reply(404, { error: 'Property not found.' });
      const found = await promo.findPromo(p.id, body.promo);
      const general = await promo.promoProblem(found, null, null);
      if (general) return reply(200, { error: general });
      const prices = {};
      ratesFor(p).forEach((r, i) => {
        const key = r.id || String(i);
        const ok = !(Array.isArray(found.rate_ids) && found.rate_ids.length && !found.rate_ids.includes(String(r.id || r.name)));
        prices[key] = ok ? promo.priceWith(found, Math.round(Number(r.amount))) : null;
      });
      return reply(200, { promo: { code: found.code, label: promo.promoLabel(found) }, prices });
    } catch (err) {
      console.error('park-lookup promo error:', err.message);
      return reply(500, { error: 'Couldn\'t check that code. Please try again.' });
    }
  }

  let filter;
  if (body.id && UUID_RE.test(String(body.id))) filter = `id=eq.${body.id}`;
  else {
    const code = normalizeCode(body.code);
    if (!code) return reply(404, { error: 'Property code not found.' });
    filter = `park_code=eq.${encodeURIComponent(code)}`;
  }

  try {
    let rows;
    try {
      rows = await sb('GET', `properties?${filter}&select=*&limit=1`);
    } catch (e) {
      // Database not updated yet (park codes SQL not run): still serve lookups by id
      if (!body.id) throw e;
      rows = await sb('GET', `properties?${filter}&select=id,name,address,transient_rates&limit=1`);
    }
    const p = rows && rows[0];
    if (!p) return reply(404, { error: 'Property code not found.' });
    if (p.features && p.features.pay_to_park === false) return reply(410, { error: 'Pay to Park isn\'t offered at this property. Please check the signs or contact the property manager.' });
    const { termsFor } = require('./lib/terms');
    const terms = await termsFor(p.id, 'pay');
    return reply(200, {
      terms,
      property: {
        id: p.id, name: p.name, address: p.address || '',
        park_code: p.park_code || null,
        stall_mode: p.stall_mode || 'off',
        promos: await hasPromos(p.id),
        rates: ratesFor(p).map(r => ({ id: r.id || null, name: r.name, minutes: r.minutes, amount: r.amount, desc: r.desc || '' })),
      },
    });
  } catch (err) {
    console.error('park-lookup error:', err.message);
    return reply(500, { error: 'Something went wrong. Please try again.' });
  }
};

// Show the promo code box only when the property has a code that's on
async function hasPromos(propertyId) {
  try { return (await sb('GET', `promo_codes?property_id=eq.${propertyId}&active=eq.true&select=id&limit=1`)).length > 0; }
  catch { return false; }
}

exports.normalizeCode = normalizeCode;
