exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const body = JSON.parse(event.body);
    const { imageData, mediaType, textOnly, description } = body;

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
