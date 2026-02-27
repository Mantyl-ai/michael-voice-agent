/**
 * Michael — BDR Voice Agent — Debrief Proxy (Claude API)
 *
 * Generates post-call analysis: transcript summary, meeting details,
 * next steps, and follow-up email using Claude.
 *
 * @endpoint POST /api/debrief → /.netlify/functions/debrief
 * @env ANTHROPIC_API_KEY — Required.
 */

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

const ALLOWED_ORIGINS = [
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

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ error: { message: 'Anthropic API key not configured.' } }),
    };
  }

  try {
    const { transcript, context } = JSON.parse(event.body);

    const systemPrompt = `You are analyzing a cold call transcript between Michael (a BDR/sales development rep) and a prospect. Generate a structured debrief.

CONTEXT:
- Michael's Company: ${context.company || 'Unknown'}
- Product/Service Being Sold: ${context.selling || 'Unknown'}
- Prospect: ${context.firstName || 'Unknown'} ${context.lastName || ''}
- Tone Used: ${context.tone || 'professional'}
${context.industry ? `- Industry: ${context.industry}` : ''}

Provide your analysis in these exact sections:

## CALL SUMMARY
[2-3 sentence overview: how the call went, key moments, and outcome]

## MEETING DETAILS
Meeting Booked: [YES/NO]
Proposed Time: [if discussed, otherwise "Not discussed"]
Prospect Interest Level: [HIGH/MEDIUM/LOW]
Key Objections Raised: [list any, or "None"]
Call Duration Highlights: [what worked well, what could improve]

## NEXT STEPS
[Numbered list of 3-5 specific, actionable next steps for the sales team]

## FOLLOW-UP EMAIL
Subject: [specific, relevant subject line]
[Professional follow-up email, 100-150 words, referencing specific points from the call. Address the prospect by first name. Include a clear CTA.]`;

    const messages = [
      {
        role: 'user',
        content: `Here is the full call transcript:\n\n${transcript}\n\nPlease generate the debrief.`,
      },
    ];

    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        system: systemPrompt,
        messages,
      }),
    });

    const data = await response.json();

    if (data.content && data.content[0]) {
      return {
        statusCode: 200,
        headers: cors,
        body: JSON.stringify({
          content: data.content[0].text,
          model: data.model,
          usage: data.usage,
        }),
      };
    }

    return {
      statusCode: response.status,
      headers: cors,
      body: JSON.stringify({ error: { message: data.error?.message || 'Debrief generation failed.' } }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ error: { message: 'Internal server error.' } }),
    };
  }
};
