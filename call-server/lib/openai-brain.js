/**
 * OpenAI GPT-4o — Michael's Brain
 *
 * Handles multi-turn conversation for the cold call.
 * Keeps responses short and natural for phone conversation.
 */

const OpenAI = require('openai');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Generate Michael's next response in the conversation.
 *
 * @param {string} systemPrompt - Michael's persona + context
 * @param {Array} messages - Conversation history [{role, content}]
 * @returns {string} Michael's response text
 */
async function generateResponse(systemPrompt, messages) {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    temperature: 0.85,
    max_tokens: 200, // Keep it short — this is a phone call
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages,
    ],
  });

  return response.choices[0]?.message?.content || '';
}

module.exports = { generateResponse };
