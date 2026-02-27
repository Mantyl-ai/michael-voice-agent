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
 */

const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

/**
 * Initialize a Deepgram live transcription connection.
 *
 * @param {string} sessionId - For logging
 * @param {Object} callbacks
 * @param {Function} callbacks.onTranscript - (text, isFinal) => void
 * @param {Function} callbacks.onError - (error) => void
 * @returns {Object} Deepgram live connection
 */
async function initDeepgram(sessionId, { onTranscript, onError }) {
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
  });

  return new Promise((resolve, reject) => {
    connection.on(LiveTranscriptionEvents.Open, () => {
      console.log(`[${sessionId}] Deepgram connection opened`);

      connection.on(LiveTranscriptionEvents.Transcript, (data) => {
        const transcript = data.channel?.alternatives?.[0]?.transcript;
        if (!transcript) return;

        const isFinal = data.is_final;
        onTranscript(transcript, isFinal);
      });

      connection.on(LiveTranscriptionEvents.UtteranceEnd, () => {
        // Utterance boundary detected (silence after speech)
        // This helps with turn-taking in the conversation
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

module.exports = { initDeepgram, processAudio };
