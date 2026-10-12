// Only logged-in managers/admins may use the AI helper (it runs on your AI bill).
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const DAILY_LIMIT = 20;                 // imports per user per day
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_DESCRIPTION = 4000;            // characters
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

function deny(statusCode, error) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error }) };
}
async function sbFetch(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts, headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const t = await res.text(); return t ? JSON.parse(t) : null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    // 1. Who is asking?
    const jwt = String(event.headers?.authorization || event.headers?.Authorization || '').replace(/^Bearer\s+/i, '');
    if (!jwt) return deny(401, 'Please sign in again.');
    const who = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${jwt}` } });
    if (!who.ok) return deny(401, 'Please sign in again.');
    const { id: userId } = await who.json();
    const [me] = await sbFetch(`users?id=eq.${userId}&select=role`);
    if (!['manager', 'admin'].includes(me?.role)) return deny(403, 'Not allowed');

    const body = JSON.parse(event.body || '{}');
    const { imageData, mediaType, textOnly, description } = body;

    // 2. Size limits
    if (imageData && (typeof imageData !== 'string' || imageData.length * 0.75 > MAX_IMAGE_BYTES)) return deny(413, 'Image is too large (max 5 MB).');
    if (imageData && mediaType && !IMAGE_TYPES.includes(mediaType)) return deny(400, 'Please upload a JPG, PNG, WEBP or GIF image.');
    if (description && String(description).length > MAX_DESCRIPTION) return deny(400, 'Description is too long.');

    // 3. Daily limit per user
    const since = new Date(Date.now() - 24 * 3600e3).toISOString();
    const used = await sbFetch(`ai_usage?user_id=eq.${userId}&created_at=gte.${encodeURIComponent(since)}&select=id`);
    if ((used || []).length >= DAILY_LIMIT) return deny(429, `Daily limit reached (${DAILY_LIMIT} lot imports per day). Try again tomorrow.`);
    await sbFetch('ai_usage', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ user_id: userId, feature: 'analyze-lot' }) });

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return { statusCode: 500, body: JSON.stringify({ error: 'API key not configured' }) };
    }

    let messages;

    if (textOnly && description) {
      // Text-only mode — no image needed
      messages = [{
        role: 'user',
        content: `You are a parking lot layout generator. Based on the description below, generate a JSON layout for a parking lot map.

Description: ${description}

Return ONLY valid JSON with no markdown or explanation. Use this exact format:
{
  "description": "brief summary",
  "elements": [
    {
      "type": "stall-standard",
      "count": 22,
      "label": "Row A",
      "row": "A"
    }
  ],
  "layout": "horizontal",
  "totalStalls": 80
}

Valid types: stall-standard, stall-reserved, stall-handicap, stall-ev, stall-guest, stall-moto, zone-carport, zone-garage, zone-yard, zone-storage, zone-loading, zone-firelane, zone-service, zone-landscape, label.
Be precise about counts. Each row should be a separate element entry.`
      }];
    } else if (imageData) {
      // Image mode
      messages = [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType || 'image/jpeg',
              data: imageData
            }
          },
          {
            type: 'text',
            text: `Analyze this parking lot image and generate a JSON layout. Return ONLY valid JSON with no markdown or explanation.
Format:
{
  "description": "brief summary of what you see",
  "elements": [
    {
      "type": "stall-standard",
      "count": 22,
      "label": "Row A",
      "row": "A"
    }
  ],
  "layout": "horizontal",
  "totalStalls": 80
}
Valid types: stall-standard, stall-reserved, stall-handicap, stall-ev, stall-guest, stall-moto, zone-carport, zone-garage, zone-yard, zone-storage, zone-loading, zone-firelane, zone-service, zone-landscape.
Count all visible stalls carefully. Each row is a separate element. Identify any special zones like fire lanes, loading docks, covered carports.`
          }
        ]
      }];
    } else {
      return { statusCode: 400, body: JSON.stringify({ error: 'No image data or description provided' }) };
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4000,
        messages
      })
    });

    const responseText = await response.text();

    if (!response.ok) {
      return {
        statusCode: response.status,
        body: JSON.stringify({
          error: 'Anthropic API error ' + response.status,
          details: responseText
        })
      };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: responseText
    };

  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};
