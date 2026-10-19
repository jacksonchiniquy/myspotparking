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
      rows = await sb('GET', `properties?${filter}&select=id,name,address,park_code,stall_mode,transient_rates&limit=1`);
    } catch (e) {
      // Database not updated yet (park codes SQL not run): still serve lookups by id
      if (!body.id) throw e;
      rows = await sb('GET', `properties?${filter}&select=id,name,address,transient_rates&limit=1`);
    }
    const p = rows && rows[0];
    if (!p) return reply(404, { error: 'Property code not found.' });
    return reply(200, {
      property: {
        id: p.id, name: p.name, address: p.address || '',
        park_code: p.park_code || null,
        stall_mode: p.stall_mode || 'off',
        rates: ratesFor(p).map(r => ({ id: r.id || null, name: r.name, minutes: r.minutes, amount: r.amount, desc: r.desc || '' })),
      },
    });
  } catch (err) {
    console.error('park-lookup error:', err.message);
    return reply(500, { error: 'Something went wrong. Please try again.' });
  }
};

exports.normalizeCode = normalizeCode;
