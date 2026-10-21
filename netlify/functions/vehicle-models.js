// vehicle-models.js — model names for a make (and optional year) from the
// free NHTSA vehicle database (vPIC). Used only to suggest spellings in the
// Make/Model boxes; people can still type anything. No key, no cost.
//
// GET /.netlify/functions/vehicle-models?make=Toyota&year=2022
// → { models: ["4Runner", "Camry", ...] }   (empty list if nothing found)

const cache = new Map(); // "make|year" -> { at, models }
const DAY = 24 * 3600e3;

function reply(statusCode, body, cacheSeconds = 0) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': cacheSeconds ? `public, max-age=${cacheSeconds}` : 'no-store',
    },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  const make = String(q.make || '').trim();
  const yearRaw = String(q.year || '').trim();
  const thisYear = new Date().getFullYear();
  if (!/^[A-Za-z0-9][A-Za-z0-9 .&'-]{0,29}$/.test(make)) return reply(400, { error: 'Invalid make', models: [] });
  const year = /^\d{4}$/.test(yearRaw) && +yearRaw >= 1950 && +yearRaw <= thisYear + 2 ? yearRaw : '';

  const key = make.toLowerCase() + '|' + year;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < DAY) return reply(200, { models: hit.models }, 86400);

  const url = year
    ? `https://vpic.nhtsa.dot.gov/api/vehicles/GetModelsForMakeYear/make/${encodeURIComponent(make)}/modelyear/${year}?format=json`
    : `https://vpic.nhtsa.dot.gov/api/vehicles/GetModelsForMake/${encodeURIComponent(make)}?format=json`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) throw new Error('vPIC ' + res.status);
    const data = await res.json();
    const seen = new Set(), models = [];
    for (const r of data.Results || []) {
      const name = String(r.Model_Name || '').trim();
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase()); models.push(name);
    }
    models.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    cache.set(key, { at: Date.now(), models });
    return reply(200, { models }, 86400);
  } catch (err) {
    // The page falls back to a short built-in list and free typing
    return reply(200, { models: [], unavailable: true });
  }
};
