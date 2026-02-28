/**
 * Michael — BDR Voice Agent — Post-Call Summary Email
 *
 * Sends a formatted summary email to the user via an n8n webhook.
 * The n8n workflow handles email rendering and delivery.
 *
 * @endpoint POST /api/send-summary-email → /.netlify/functions/send-summary-email
 * @env N8N_WEBHOOK_URL — Required. The n8n webhook URL.
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

  const webhookUrl = process.env.N8N_WEBHOOK_URL;
  if (!webhookUrl) {
    console.error('N8N_WEBHOOK_URL not configured');
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ error: 'Email service not configured.' }),
    };
  }

  try {
    const payload = JSON.parse(event.body);

    // Validate required fields
    const { recipientEmail, recipientName, summary, nextSteps, followUpEmail, meetingBooked, interest, proposedTime, company, selling } = payload;
    if (!recipientEmail) {
      return {
        statusCode: 400,
        headers: cors,
        body: JSON.stringify({ error: 'Recipient email is required.' }),
      };
    }

    // Forward the full payload to n8n webhook
    const n8nPayload = {
      recipientEmail,
      recipientName: recipientName || 'there',
      subject: `Your Call Debrief with Michael by Mantyl`,
      summary: summary || '',
      nextSteps: nextSteps || [],
      followUpEmail: followUpEmail || { subject: '', body: '' },
      meetingBooked: meetingBooked || 'Unknown',
      interest: interest || 'Unknown',
      proposedTime: proposedTime || 'Not discussed',
      company: company || '',
      selling: selling || '',
      bookingUrl: 'https://www.mantyl.ai/book',
      timestamp: new Date().toISOString(),
    };

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(n8nPayload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`n8n webhook error (${response.status}):`, errorText);
      return {
        statusCode: 502,
        headers: cors,
        body: JSON.stringify({ error: 'Email delivery failed.' }),
      };
    }

    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({ success: true, message: 'Summary email queued for delivery.' }),
    };
  } catch (err) {
    console.error('send-summary-email error:', err);
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ error: 'Internal server error.' }),
    };
  }
};
