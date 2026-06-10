exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const body = JSON.parse(event.body);
    const { imageData, mediaType } = body;

    if (!imageData) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No image data received' }) };
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return { statusCode: 500, body: JSON.stringify({ error: 'API key not configured in environment' }) };
    }

    console.log('API key prefix:', apiKey.substring(0, 12) + '...');
    console.log('Image data length:', imageData.length);
    console.log('Media type:', mediaType);

    const requestBody = {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      messages: [{
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
            text: 'Analyze this parking lot image. Return ONLY valid JSON with no markdown or explanation. Format: {"description":"what you see","elements":[{"type":"stall-standard","count":10,"label":"Row A","row":"A"}],"layout":"horizontal","totalStalls":10}'
          }
        ]
      }]
    };

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(requestBody)
    });

    console.log('Anthropic response status:', response.status);

    const responseText = await response.text();
    console.log('Response text preview:', responseText.substring(0, 200));

    if (!response.ok) {
      return {
        statusCode: response.status,
        body: JSON.stringify({
          error: 'Anthropic API returned error ' + response.status,
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
    console.error('Function error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: err.message,
        type: err.constructor.name
      })
    };
  }
};
