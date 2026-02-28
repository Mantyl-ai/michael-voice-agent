/**
 * Michael — BDR Voice Agent — Debrief Proxy (Claude API)
 *
 * Generates post-call analysis: transcript summary, meeting details,
 * next steps, follow-up email, AND enterprise call scoring.
 *
 * Enterprise features:
 * - Call quality scoring (0-100)
 * - Talk-time ratio analysis
 * - Objection handling assessment
 * - Qualification depth (BANT)
 * - Sentiment trajectory
 * - Callback/voicemail handling notes
 *
 * @endpoint POST /api/debrief → /.netlify/functions/debrief
 * @env ANTHROPIC_API_KEY — Required.
 */

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

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

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ error: { message: 'Anthropic API key not configured.' } }),
    };
  }

  try {
    const { transcript, context, scoring } = JSON.parse(event.body);

    // Build scoring context if available
    let scoringContext = '';
    if (scoring) {
      scoringContext = `
CALL ANALYTICS DATA (from real-time tracking):
- Overall Score: ${scoring.overallScore}/100
- Talk Ratio: Prospect spoke ${scoring.talkRatio?.prospectPercent || '?'}% / Michael spoke ${scoring.talkRatio?.michaelPercent || '?'}%
- Objections Raised: ${scoring.objectionHandling?.count || 0}
- Meeting Booked: ${scoring.meetingConversion?.booked ? 'YES' : 'NO'}
- Callback Requested: ${scoring.meetingConversion?.callbackRequested ? 'YES' : 'NO'}
- Qualification Depth (BANT): ${scoring.qualificationDepth?.depth || 0}/4 (Budget: ${scoring.qualificationDepth?.checklist?.budget ? 'Y' : 'N'}, Authority: ${scoring.qualificationDepth?.checklist?.authority ? 'Y' : 'N'}, Need: ${scoring.qualificationDepth?.checklist?.need ? 'Y' : 'N'}, Timeline: ${scoring.qualificationDepth?.checklist?.timeline ? 'Y' : 'N'})
- Sentiment Trajectory: ${scoring.sentimentTrajectory?.finalLabel || 'unknown'}
- Barge-in Count: ${scoring.bargeInCount || 0} (times prospect interrupted)
- Exchange Count: ${scoring.exchangeCount || 0} back-and-forth exchanges
`;
    }

    const systemPrompt = `You are analyzing a cold call transcript between Michael (a BDR/sales development rep) and a prospect. Generate a structured debrief with scoring.

CONTEXT:
- Michael's Company: ${context.company || 'Unknown'}
- Product/Service Being Sold: ${context.selling || 'Unknown'}
- Prospect: ${context.firstName || 'Unknown'} ${context.lastName || ''}
- Tone Used: ${context.tone || 'professional'}
${context.industry ? `- Industry: ${context.industry}` : ''}
${scoringContext}

Provide your analysis in these exact sections:

## CALL SCORE: [X/100]
[One sentence: what this score means — e.g. "Strong discovery call with good objection handling but missed the close."]

## SCORECARD
| Metric | Score | Notes |
|--------|-------|-------|
| Talk Ratio | [1-5] | [How balanced was the conversation? Ideal: prospect 60-70%] |
| Objection Handling | [1-5] | [How well did Michael handle pushback?] |
| Meeting Conversion | [1-5] | [Did Michael successfully book a meeting?] |
| Sentiment Management | [1-5] | [Did the prospect's sentiment improve over the call?] |
| Qualification Depth | [1-5] | [How many BANT criteria were explored?] |

## CALL SUMMARY
[2-3 sentence overview: how the call went, key moments, and outcome]

## MEETING DETAILS
Meeting Booked: [YES/NO]
Proposed Time: [if discussed, otherwise "Not discussed"]
Prospect Interest Level: [HIGH/MEDIUM/LOW]
Key Objections Raised: [list any, or "None"]
Call Duration Highlights: [what worked well, what could improve]

## COACHING NOTES
[2-3 specific, actionable coaching tips for Michael to improve. Reference specific moments in the call.]

## NEXT STEPS
[Numbered list of 3-5 specific, actionable next steps for the sales team]

## FOLLOW-UP EMAIL
Subject: [specific, relevant subject line]
[Professional follow-up email, 100-150 words, referencing specific points from the call. Address the prospect by first name. Include a clear CTA.]`;

    const messages = [
      {
        role: 'user',
        content: `Here is the full call transcript:\n\n${transcript}\n\nPlease generate the debrief with scoring.`,
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
        max_tokens: 3000,
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
          scoring, // Pass through the real-time scoring data
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
