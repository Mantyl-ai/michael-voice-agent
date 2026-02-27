/**
 * ElevenLabs TTS — Michael's Voice
 *
 * Converts text to speech using ElevenLabs API.
 * Returns audio as mulaw 8kHz buffer (Twilio's required format).
 *
 * Uses the streaming endpoint for lowest latency.
 * Then converts mp3 → raw PCM → mulaw using ffmpeg.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'pdoiqZrWfcY60KV2vt2G';
const TTS_URL = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`;

/**
 * Synthesize speech and return mulaw 8kHz audio buffer for Twilio.
 *
 * @param {string} text - Text to speak
 * @returns {Buffer|null} Mulaw audio buffer, or null on failure
 */
async function synthesizeSpeech(text) {
  if (!text || !text.trim()) return null;

  try {
    // Call ElevenLabs TTS API
    const response = await fetch(TTS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': ELEVENLABS_API_KEY,
        'Accept': 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_turbo_v2_5',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.8,
          style: 0.3,
          use_speaker_boost: true,
        },
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('ElevenLabs TTS error:', err);
      return null;
    }

    // Get mp3 audio as buffer
    const mp3Buffer = Buffer.from(await response.arrayBuffer());

    // Convert mp3 → mulaw 8kHz using ffmpeg
    const mulawBuffer = convertToMulaw(mp3Buffer);
    return mulawBuffer;
  } catch (err) {
    console.error('ElevenLabs TTS error:', err.message);
    return null;
  }
}

/**
 * Convert mp3 audio to mulaw 8kHz mono using ffmpeg.
 * Twilio Media Streams require mulaw (G.711 u-law) at 8kHz sample rate.
 *
 * @param {Buffer} mp3Buffer - MP3 audio data
 * @returns {Buffer} Mulaw audio data
 */
function convertToMulaw(mp3Buffer) {
  const tmpDir = os.tmpdir();
  const inputPath = path.join(tmpDir, `michael-tts-${Date.now()}.mp3`);
  const outputPath = path.join(tmpDir, `michael-tts-${Date.now()}.raw`);

  try {
    // Write mp3 to temp file
    fs.writeFileSync(inputPath, mp3Buffer);

    // Convert with ffmpeg: mp3 → mulaw 8kHz mono
    execSync(
      `ffmpeg -y -i "${inputPath}" -ar 8000 -ac 1 -f mulaw "${outputPath}"`,
      { stdio: 'pipe', timeout: 10000 }
    );

    // Read converted audio
    const mulawBuffer = fs.readFileSync(outputPath);
    return mulawBuffer;
  } catch (err) {
    console.error('ffmpeg conversion error:', err.message);
    return null;
  } finally {
    // Clean up temp files
    try { fs.unlinkSync(inputPath); } catch {}
    try { fs.unlinkSync(outputPath); } catch {}
  }
}

module.exports = { synthesizeSpeech };
