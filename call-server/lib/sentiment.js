/**
 * Sentiment Analysis — Real-time prospect emotion tracking
 *
 * Analyzes prospect speech to determine emotional state and engagement level.
 * Uses keyword/pattern-based analysis (no external API needed — zero latency).
 *
 * Score range: -10 (hostile) to +10 (enthusiastic)
 * Labels: hostile, negative, neutral, positive, enthusiastic
 *
 * The sentiment is injected into Michael's system prompt so he can adapt
 * his tone and approach in real-time.
 */

// Positive signal words/phrases (weighted)
const POSITIVE_SIGNALS = [
  { pattern: /that('s| is) (great|awesome|amazing|fantastic|perfect|excellent)/i, weight: 3 },
  { pattern: /i('m| am) (interested|intrigued|curious)/i, weight: 3 },
  { pattern: /tell me more/i, weight: 2 },
  { pattern: /how (does|would|can) (that|it|this) work/i, weight: 2 },
  { pattern: /sounds (good|great|interesting|promising)/i, weight: 2 },
  { pattern: /that makes sense/i, weight: 1 },
  { pattern: /\b(yeah|yes|sure|absolutely|definitely)\b/i, weight: 1 },
  { pattern: /i (like|love|appreciate) that/i, weight: 2 },
  { pattern: /we('ve| have) been (looking|searching|thinking)/i, weight: 3 },
  { pattern: /what('s| is) the (price|cost|investment)/i, weight: 2 }, // buying signal
  { pattern: /can you send me/i, weight: 2 },
  { pattern: /let('s| us) (set up|schedule|book)/i, weight: 4 },
  { pattern: /i('d| would) (like|love) to/i, weight: 2 },
  { pattern: /\bhaha|lol|funny\b/i, weight: 1 },
];

// Negative signal words/phrases (weighted)
const NEGATIVE_SIGNALS = [
  { pattern: /not interested/i, weight: -3 },
  { pattern: /no thanks/i, weight: -2 },
  { pattern: /stop calling/i, weight: -5 },
  { pattern: /take me off/i, weight: -5 },
  { pattern: /don't call (me |again)/i, weight: -5 },
  { pattern: /waste (of |my )time/i, weight: -4 },
  { pattern: /\b(annoying|annoyed|frustrated|irritated)\b/i, weight: -3 },
  { pattern: /i('m| am) (busy|in a meeting|driving)/i, weight: -2 },
  { pattern: /we('re| are) (good|fine|all set|happy) (with|as)/i, weight: -2 },
  { pattern: /already (have|using|got)/i, weight: -1 },
  { pattern: /too expensive/i, weight: -2 },
  { pattern: /no budget/i, weight: -2 },
  { pattern: /send (me |an )?email/i, weight: -1 }, // polite brush-off
  { pattern: /who (is this|are you|gave you)/i, weight: -2 },
  { pattern: /how did you get (my|this)/i, weight: -3 },
];

/**
 * Analyze a single utterance and return a sentiment delta
 *
 * @param {string} text - Prospect's speech
 * @returns {{ delta: number, signals: string[] }}
 */
function analyzeUtterance(text) {
  if (!text || !text.trim()) return { delta: 0, signals: [] };

  let delta = 0;
  const signals = [];

  for (const { pattern, weight } of POSITIVE_SIGNALS) {
    if (pattern.test(text)) {
      delta += weight;
      signals.push(`+${weight}: ${pattern.source.substring(0, 30)}`);
    }
  }

  for (const { pattern, weight } of NEGATIVE_SIGNALS) {
    if (pattern.test(text)) {
      delta += weight; // weight is already negative
      signals.push(`${weight}: ${pattern.source.substring(0, 30)}`);
    }
  }

  // Short, curt responses are slightly negative (disengaged)
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (wordCount <= 2 && delta === 0) {
    delta -= 0.5;
    signals.push('-0.5: curt response');
  }

  // Long, detailed responses are slightly positive (engaged)
  if (wordCount > 20 && delta >= 0) {
    delta += 1;
    signals.push('+1: detailed response');
  }

  return { delta, signals };
}

/**
 * Update session sentiment from a new prospect utterance
 *
 * @param {Object} session - CallSession instance
 * @param {string} text - Prospect's latest speech
 * @returns {{ score: number, label: string, delta: number }}
 */
function updateSentiment(session, text) {
  const { delta, signals } = analyzeUtterance(text);

  // Apply delta with decay toward neutral (prevents runaway scores)
  session.sentimentScore = Math.max(-10, Math.min(10,
    session.sentimentScore * 0.85 + delta // 15% decay toward 0
  ));

  // Determine label
  const score = session.sentimentScore;
  if (score <= -6) session.sentimentLabel = 'hostile';
  else if (score <= -2) session.sentimentLabel = 'negative';
  else if (score <= 2) session.sentimentLabel = 'neutral';
  else if (score <= 6) session.sentimentLabel = 'positive';
  else session.sentimentLabel = 'enthusiastic';

  // Record history
  session.sentimentHistory.push({
    turn: session.transcript.length,
    score: Math.round(session.sentimentScore * 10) / 10,
    label: session.sentimentLabel,
  });

  if (signals.length > 0) {
    console.log(`[${session.sessionId}] Sentiment: ${session.sentimentLabel} (${session.sentimentScore.toFixed(1)}) — signals: ${signals.join(', ')}`);
  }

  return {
    score: session.sentimentScore,
    label: session.sentimentLabel,
    delta,
  };
}

/**
 * Generate a sentiment-aware system prompt injection
 * This gets appended to Michael's system prompt dynamically
 *
 * @param {Object} session - CallSession instance
 * @returns {string} Prompt injection text, or empty string if neutral
 */
function getSentimentPromptInjection(session) {
  const { sentimentLabel, sentimentScore, bargeInCount } = session;

  const injections = {
    hostile: `\n\nSENTIMENT ALERT — HOSTILE (${sentimentScore.toFixed(1)}/10):
The prospect is clearly irritated or angry. You MUST:
- Acknowledge their frustration immediately ("I hear you, and I respect your time")
- Do NOT push the sale. Offer to follow up via email instead
- If they say "stop" or "don't call", thank them and end gracefully
- Keep your next response to ONE short sentence max`,

    negative: `\n\nSENTIMENT NOTE — NEGATIVE (${sentimentScore.toFixed(1)}/10):
The prospect is showing resistance. Adapt by:
- Being more empathetic and less pushy
- Acknowledging their concern before redirecting
- Offering a softer ask (email follow-up vs. meeting)
- Keep responses shorter than usual`,

    neutral: '', // No injection needed for neutral

    positive: `\n\nSENTIMENT NOTE — POSITIVE (${sentimentScore.toFixed(1)}/10):
The prospect is engaged! Lean in by:
- Asking deeper qualifying questions
- Being more direct about the meeting ask
- Building on their interest with specific value props`,

    enthusiastic: `\n\nSENTIMENT NOTE — ENTHUSIASTIC (${sentimentScore.toFixed(1)}/10):
The prospect is very interested! Strike while hot:
- Go for the meeting booking NOW
- Be confident and direct with scheduling
- Mirror their enthusiasm`,
  };

  let injection = injections[sentimentLabel] || '';

  // Add barge-in awareness
  if (bargeInCount >= 2) {
    injection += `\n\nNOTE: The prospect has interrupted you ${bargeInCount} times. Keep your responses SHORTER (1 sentence max) and more concise.`;
  }

  return injection;
}

module.exports = { analyzeUtterance, updateSentiment, getSentimentPromptInjection };
