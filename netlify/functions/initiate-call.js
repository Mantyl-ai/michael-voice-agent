/**
 * Michael — BDR Voice Agent — Call Initiation Proxy
 *
 * Netlify serverless function that forwards call requests to the
 * Railway-hosted call server. Acts as a secure proxy so the browser
 * never talks directly to the call server.
 *
 * @endpoint POST /api/initiate-call → /.netlify/functions/initiate-call
 * @env CALL_SERVER_URL — URL of the Railway call server
 * @env CALL_SERVER_SECRET — Shared secret for authentication
 */

const ALLOWED_ORIGINS = [
  'https://michael-voice-agent.netlify.app',
  'https://michael.mantyl.ai',
  'https://tools.mantyl.ai',
  'http://localhost:8888',
  'http://localhost:3000',
];

function getCorsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };
}

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';
  const cors = getCorsHeaders(origin);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const callServerUrl = process.env.CALL_SERVER_URL;
  const callServerSecret = process.env.CALL_SERVER_SECRET;

  if (!callServerUrl || !callServerSecret) {
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ error: { message: 'Server configuration error: Call server not configured.' } }),
    };
  }

  try {
    const body = JSON.parse(event.body);

    // Forward to call server
    const response = await fetch(`${callServerUrl}/call/initiate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${callServerSecret}`,
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();

    return {
      statusCode: response.status,
      headers: cors,
      body: JSON.stringify(data),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ error: { message: 'Failed to initiate call. Please try again.' } }),
    };
  }
};
