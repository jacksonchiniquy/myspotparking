// Parking areas ("Where are you parked?") — tidy up a list before saving it.
// Each area: { id, name, desc }. The id never changes, so rates, promo codes
// and printed QR stickers keep working when an area is renamed.

function cleanAreas(list) {
  if (!Array.isArray(list)) return { error: 'Areas must be a list.' };
  if (list.length > 50) return { error: 'Up to 50 areas per property.' };
  const out = [], seen = new Set();
  for (const a of list) {
    const name = String((a && a.name) || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) return { error: `"${name}" is listed twice.` };
    seen.add(key);
    let id = String((a && a.id) || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
    if (!id) id = 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    out.push({ id, name, desc: String((a && a.desc) || '').replace(/\s+/g, ' ').trim().slice(0, 80) });
  }
  return { areas: out };
}

module.exports = { cleanAreas };
