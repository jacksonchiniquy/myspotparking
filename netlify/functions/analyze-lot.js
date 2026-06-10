exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { imageData, mediaType } = JSON.parse(event.body);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data: imageData }
            },
            {
              type: 'text',
              text: `Analyze this parking lot image and identify the parking layout. Return ONLY a JSON object with no explanation, no markdown, no backticks. The JSON must have this exact structure:
{
  "description": "brief description of what you see",
  "elements": [
    {
      "type": "stall-standard|stall-reserved|stall-handicap|stall-ev|stall-guest|zone-carport|zone-garage|zone-yard|zone-storage|zone-loading|zone-firelane|zone-landscape|label",
      "count": 1,
      "label": "descriptive label",
      "row": "A or B or null",
      "notes": "any relevant notes"
    }
  ],
  "layout": "horizontal or vertical",
  "totalStalls": 0
}
Be accurate about stall types and counts. Group stalls in the same row together.`
            }
          ]
        }]
      })
    });

    const data = await response.json();
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    };

  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};
