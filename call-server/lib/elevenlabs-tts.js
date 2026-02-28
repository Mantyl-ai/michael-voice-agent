/**
 * ElevenLabs TTS — Michael's Voice
 *
 * Converts text to speech using ElevenLabs API.
 * Returns audio as mulaw 8kHz buffer (Twilio's required format).
 *
 * Uses the streaming endpoint for lowest latency.
 * Then converts mp3 → raw PCM → mulaw using ffmpeg.
 *
 * Enterprise features:
 * - Response caching: Pre-generated audio for common phrases (50ms vs 500ms+)
 * - Cache hit/miss logging for monitoring
 */

const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
const fs = require('fs');
const path = require('path');
const os = require('os');

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'pdoiqZrWfcY60KV2vt2G';
const TTS_URL = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`;

console.log(`[TTS] Voice ID: ${VOICE_ID}`);
console.log(`[TTS] API Key set: ${!!ELEVENLABS_API_KEY}`);

// ─── Enterprise: Response Cache ───
// LRU-style cache for frequently spoken phrases
// Key: normalized text, Value: { mulawBuffer, createdAt, hitCount }
const responseCache = new Map();
const CACHE_MAX_SIZE = 50;
const CACHE_TTL_MS = 3600000; // 1 hour

// Phrases that are very likely to be spoken — pre-warm on first call
const COMMON_PHRASES = [
  'Could you give me 30 seconds?',
  'I totally understand.',
  'That makes sense.',
  "I appreciate your time.",
  'Let me be quick.',
  'Absolutely, I hear you.',
  "That's a great question.",
  "Here's the thing.",
];

let cacheStats = { hits: 0, misses: 0 };

function normalizeForCache(text) {
  return (text || '').trim().toLowerCase().replace(/[^\w\s]/g, '');
}

function getCachedAudio(text) {
  const key = normalizeForCache(text);
  const entry = responseCache.get(key);
  if (entry && (Date.now() - entry.createdAt) < CACHE_TTL_MS) {
    entry.hitCount++;
    cacheStats.hits++;
    console.log(`[TTS-Cache] HIT: "${text.substring(0, 40)}..." (hits: ${entry.hitCount})`);
    return entry.mulawBuffer;
  }
  cacheStats.misses++;
  return null;
}

function setCachedAudio(text, mulawBuffer) {
  const key = normalizeForCache(text);

  // Evict oldest if at capacity
  if (responseCache.size >= CACHE_MAX_SIZE) {
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [k, v] of responseCache) {
      if (v.createdAt < oldestTime) {
        oldestTime = v.createdAt;
        oldestKey = k;
      }
    }
    if (oldestKey) responseCache.delete(oldestKey);
  }

  responseCache.set(key, {
    mulawBuffer,
    createdAt: Date.now(),
    hitCount: 0,
  });
}

/**
 * Pre-warm the cache with common phrases (called once on first call)
 */
let cacheWarmed = false;
async function warmCache() {
  if (cacheWarmed) return;
  cacheWarmed = true;
  console.log(`[TTS-Cache] Warming cache with ${COMMON_PHRASES.length} common phrases...`);

  // Warm in background — don't block
  for (const phrase of COMMON_PHRASES) {
    try {
      const buffer = await synthesizeSpeechInternal(phrase);
      if (buffer) setCachedAudio(phrase, buffer);
    } catch (e) {
      console.error(`[TTS-Cache] Warm failed for: "${phrase}": ${e.message}`);
    }
  }
  console.log(`[TTS-Cache] Cache warmed: ${responseCache.size} entries`);
}

/**
 * Synthesize speech and return mulaw 8kHz audio buffer for Twilio.
 * Checks cache first for ~50ms response on common phrases.
 *
 * @param {string} text - Text to speak
 * @returns {Buffer|null} Mulaw audio buffer, or null on failure
 */
async function synthesizeSpeech(text) {
  if (!text || !text.trim()) {
    console.log('[TTS] Skipped: empty text');
    return null;
  }

  // Warm cache on first call (non-blocking background)
  if (!cacheWarmed) warmCache();

  // Check cache first
  const cached = getCachedAudio(text);
  if (cached) return cached;

  // Cache miss — generate fresh
  const buffer = await synthesizeSpeechInternal(text);

  // Cache short responses (likely to repeat)
  if (buffer && text.length < 100) {
    setCachedAudio(text, buffer);
  }

  return buffer;
}

/**
 * Internal synthesis — always hits ElevenLabs API
 */
async function synthesizeSpeechInternal(text) {
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

    // Convert mp3 → mulaw 8kHz using ffmpeg (async — won't block event loop)
    const mulawBuffer = await convertToMulaw(mp3Buffer);
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
 * IMPORTANT: Uses async exec to avoid blocking the event loop.
 * Blocking the event loop during conversion prevents WebSocket ping/pong
 * processing, which causes Twilio and Deepgram to disconnect mid-call.
 *
 * @param {Buffer} mp3Buffer - MP3 audio data
 * @returns {Buffer|null} Mulaw audio data, or null on failure
 */
async function convertToMulaw(mp3Buffer) {
  const tmpDir = os.tmpdir();
  const ts = Date.now();
  const inputPath = path.join(tmpDir, `michael-tts-${ts}.mp3`);
  const outputPath = path.join(tmpDir, `michael-tts-${ts}.raw`);

  try {
    // Write mp3 to temp file
    fs.writeFileSync(inputPath, mp3Buffer);
    console.log(`[TTS] Wrote ${mp3Buffer.length} bytes to ${inputPath}`);

    // Convert with ffmpeg: mp3 → mulaw 8kHz mono (ASYNC — does not block event loop)
    const { stderr } = await execAsync(
      `ffmpeg -y -i "${inputPath}" -ar 8000 -ac 1 -f mulaw "${outputPath}"`,
      { timeout: 10000 }
    );
    if (stderr) console.log(`[TTS] ffmpeg: ${stderr.substring(0, 200)}`);

    // Read converted audio
    const mulawBuffer = fs.readFileSync(outputPath);
    console.log(`[TTS] Mulaw output: ${mulawBuffer.length} bytes`);
    return mulawBuffer;
  } catch (err) {
    console.error(`[TTS] ffmpeg conversion error: ${err.message}`);
    if (err.stderr) console.error(`[TTS] ffmpeg stderr: ${err.stderr.substring(0, 500)}`);
    return null;
  } finally {
    // Clean up temp files
    try { fs.unlinkSync(inputPath); } catch {}
    try { fs.unlinkSync(outputPath); } catch {}
  }
}

function getCacheStats() {
  return { ...cacheStats, size: responseCache.size };
}

module.exports = { synthesizeSpeech, getCacheStats };
