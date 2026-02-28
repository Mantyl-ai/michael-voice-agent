/**
 * Deepgram Real-Time Speech-to-Text
 *
 * Connects to Deepgram's streaming API to transcribe audio from Twilio
 * Media Streams in real-time. Twilio sends mulaw 8kHz mono audio.
 *
 * Features:
 * - Interim results for real-time UI feedback
 * - Final results trigger Michael's response generation
 * - Utterance end detection for natural conversation flow
 *
 * Enterprise features:
 * - Language detection (detect non-English speech)
 * - Semantic turn detection (context-aware endpointing)
 */

const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

// ─── Enterprise: Semantic Turn Detection ───
// Patterns that suggest the speaker is MID-THOUGHT (don't interrupt)
const MID_THOUGHT_PATTERNS = [
  /\b(and|but|so|because|however|also|plus|actually|basically|well)\s*$/i,
  /,\s*$/,  // trailing comma
  /\b(i think|i mean|you know|like)\s*$/i,
  /\b(the thing is|here's what|what i'm saying is)\s*$/i,
];

// Patterns that suggest the speaker has FINISHED their thought
const END_OF_TURN_PATTERNS = [
  /[.!?]\s*$/,  // ends with punctuation
  /\b(right|okay|sure|yeah|yes|no|nah|nope)\s*[.!?]?\s*$/i,
  /\b(bye|goodbye|take care|have a good one)\s*[.!?]?\s*$/i,
  /\b(what do you think|does that make sense|you know what i mean)\s*[.!?]?\s*$/i,
  /\b(that's it|that's all|i'm done)\s*[.!?]?\s*$/i,
];

/**
 * Analyze if the current transcript suggests the speaker is done talking
 *
 * @param {string} text - Current transcript text
 * @param {string} fullContext - Full conversation so far
 * @returns {'complete' | 'mid-thought' | 'ambiguous'}
 */
function analyzeTurnCompletion(text) {
  if (!text || !text.trim()) return 'ambiguous';

  const trimmed = text.trim();

  // Check end-of-turn first (higher priority)
  if (END_OF_TURN_PATTERNS.some(p => p.test(trimmed))) return 'complete';

  // Check mid-thought
  if (MID_THOUGHT_PATTERNS.some(p => p.test(trimmed))) return 'mid-thought';

  // Short responses (1-3 words) are usually complete turns
  if (trimmed.split(/\s+/).length <= 3) return 'complete';

  return 'ambiguous';
}

/**
 * Initialize a Deepgram live transcription connection.
 *
 * @param {string} sessionId - For logging
 * @param {Object} callbacks
 * @param {Function} callbacks.onTranscript - (text, isFinal, metadata) => void
 * @param {Function} callbacks.onUtteranceEnd - () => void
 * @param {Function} callbacks.onError - (error) => void
 * @returns {Object} Deepgram live connection
 */
async function initDeepgram(sessionId, { onTranscript, onUtteranceEnd, onError }) {
  const deepgram = createClient(DEEPGRAM_API_KEY);

  const connection = deepgram.listen.live({
    model: 'nova-2',
    language: 'en-US',
    smart_format: true,
    encoding: 'mulaw',
    sample_rate: 8000,
    channels: 1,
    interim_results: true,
    utterance_end_ms: 1200,
    endpointing: 400,
    punctuate: true,
    filler_words: true,
    // Enterprise: Enable language detection
    detect_language: true,
  });

  return new Promise((resolve, reject) => {
    connection.on(LiveTranscriptionEvents.Open, () => {
      console.log(`[${sessionId}] Deepgram connection opened`);

      connection.on(LiveTranscriptionEvents.Transcript, (data) => {
        const transcript = data.channel?.alternatives?.[0]?.transcript;
        if (!transcript) return;

        const isFinal = data.is_final;

        // Enterprise: Extract language detection info
        const detectedLanguage = data.channel?.alternatives?.[0]?.languages?.[0] ||
          data.channel?.detected_language || null;
        const confidence = data.channel?.alternatives?.[0]?.confidence || 0;

        // Enterprise: Semantic turn analysis on final transcripts
        let turnStatus = 'ambiguous';
        if (isFinal) {
          turnStatus = analyzeTurnCompletion(transcript);
        }

        onTranscript(transcript, isFinal, {
          detectedLanguage,
          confidence,
          turnStatus,
        });
      });

      connection.on(LiveTranscriptionEvents.UtteranceEnd, () => {
        // Utterance boundary detected (silence after speech)
        // This helps with turn-taking in the conversation
        if (onUtteranceEnd) onUtteranceEnd();
      });

      connection.on(LiveTranscriptionEvents.Error, (err) => {
        console.error(`[${sessionId}] Deepgram error:`, err);
        if (onError) onError(err);
      });

      connection.on(LiveTranscriptionEvents.Close, () => {
        console.log(`[${sessionId}] Deepgram connection closed`);
      });

      resolve(connection);
    });

    connection.on(LiveTranscriptionEvents.Error, (err) => {
      reject(err);
    });
  });
}

/**
 * Send audio data to Deepgram for transcription.
 *
 * @param {Object} connection - Deepgram live connection
 * @param {Buffer} audioData - Raw mulaw audio bytes from Twilio
 */
function processAudio(connection, audioData) {
  if (connection.getReadyState() === 1) { // WebSocket.OPEN
    connection.send(audioData);
  }
}

module.exports = { initDeepgram, processAudio, analyzeTurnCompletion };
