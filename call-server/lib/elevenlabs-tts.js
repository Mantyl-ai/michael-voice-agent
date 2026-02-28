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

console.log(`[TTS] Voice ID: ${VOICE_ID}`);
console.log(`[TTS] API Key set: ${!!ELEVENLABS_API_KEY}`);

/**
 * Synthesize speech and return mulaw 8kHz audio buffer for Twilio.
 *
 * @param {string} text - Text to speak
 * @returns {Buffer|null} Mulaw audio buffer, or null on failure
 */
async function synthesizeSpeech(text) {
  if (!text || !text.trim()) {
    console.log('[TTS] Skipped: empty text');
    return null;
  }

  const startTime = Date.now();
  console.log(`[TTS] Synthesizing ${text.length} chars: "${text.substring(0, 80)}..."`);

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
      console.error(`[TTS] ElevenLabs API error ${response.status}: ${err}`);
      return null;
    }

    // Get mp3 audio as buffer
    const mp3Buffer = Buffer.from(await response.arrayBuffer());
    const apiTime = Date.now() - startTime;
    console.log(`[TTS] ElevenLabs returned ${mp3Buffer.length} bytes MP3 in ${apiTime}ms`);

    if (mp3Buffer.length < 100) {
      console.error(`[TTS] MP3 buffer suspiciously small (${mp3Buffer.length} bytes), skipping`);
      return null;
    }

    // Convert mp3 → mulaw 8kHz using ffmpeg
    const mulawBuffer = convertToMulaw(mp3Buffer);
    const totalTime = Date.now() - startTime;

    if (mulawBuffer) {
      console.log(`[TTS] Conversion complete: ${mulawBuffer.length} bytes mulaw in ${totalTime}ms total`);
    } else {
      console.error(`[TTS] ffmpeg conversion returned null`);
    }

    return mulawBuffer;
  } catch (err) {
    console.error(`[TTS] Synthesis error: ${err.message}`);
    console.error(err.stack);
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
  const ts = Date.now();
  const inputPath = path.join(tmpDir, `michael-tts-${ts}.mp3`);
  const outputPath = path.join(tmpDir, `michael-tts-${ts}.raw`);

  try {
    // Write mp3 to temp file
    fs.writeFileSync(inputPath, mp3Buffer);
    console.log(`[TTS] Wrote ${mp3Buffer.length} bytes to ${inputPath}`);

    // Convert with ffmpeg: mp3 → mulaw 8kHz mono
    const ffmpegOutput = execSync(
      `ffmpeg -y -i "${inputPath}" -ar 8000 -ac 1 -f mulaw "${outputPath}" 2>&1`,
      { stdio: 'pipe', timeout: 10000 }
    );
    console.log(`[TTS] ffmpeg output: ${ffmpegOutput.toString().substring(0, 200)}`);

    // Read converted audio
    const mulawBuffer = fs.readFileSync(outputPath);
    console.log(`[TTS] Mulaw output: ${mulawBuffer.length} bytes`);
    return mulawBuffer;
  } catch (err) {
    console.error(`[TTS] ffmpeg conversion error: ${err.message}`);
    if (err.stderr) console.error(`[TTS] ffmpeg stderr: ${err.stderr.toString().substring(0, 500)}`);
    return null;
  } finally {
    // Clean up temp files
    try { fs.unlinkSync(inputPath); } catch {}
    try { fs.unlinkSync(outputPath); } catch {}
  }
}

module.exports = { synthesizeSpeech };
