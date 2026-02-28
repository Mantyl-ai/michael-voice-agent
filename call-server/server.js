/**
 * Michael — BDR Cold Calling Voice Agent — Call Engine Server
 *
 * This server handles the real-time phone call pipeline:
 * 1. Initiates outbound calls via Twilio
 * 2. Receives audio via Twilio Media Streams (WebSocket)
 * 3. Transcribes speech in real-time via Deepgram
 * 4. Generates responses via OpenAI GPT-4o
 * 5. Converts responses to speech via ElevenLabs
 * 6. Streams audio back to Twilio (plays to phone)
 * 7. Relays live transcript to browser via WebSocket
 *
 * Deploy to Railway (needs persistent WebSocket connections).
 */

require('dotenv').config();

// ─── Crash Protection — keep the container alive and log what killed it ───
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION — keeping server alive:', err.message);
  console.error(err.stack);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('UNHANDLED REJECTION — keeping server alive:', reason);
});

const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const twilio = require('twilio');
const { v4: uuidv4 } = require('uuid');
const { CallSession } = require('./lib/call-session');
const { initDeepgram, processAudio } = require('./lib/deepgram-stt');
const { generateResponse } = require('./lib/openai-brain');
const { synthesizeSpeech } = require('./lib/elevenlabs-tts');
const { buildSystemPrompt } = require('./lib/prompt-builder');

// ─── Config ───
const PORT = process.env.PORT || 3000;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const CALL_SERVER_SECRET = process.env.CALL_SERVER_SECRET;
// Always include the Netlify URL even if env var doesn't have it
const ALWAYS_ALLOWED = ['https://michael-voice-agent.netlify.app', 'https://michael.mantyl.ai', 'https://tools.mantyl.ai'];
const ALLOWED_ORIGINS = [...new Set([
  ...ALWAYS_ALLOWED,
  ...(process.env.ALLOWED_ORIGINS || 'http://localhost:8888,http://localhost:3000').split(','),
])].map(o => o.trim()).filter(Boolean);

let twilioClient;
try {
  twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  console.log('Twilio client initialized successfully');
} catch (err) {
  console.error('Failed to initialize Twilio client:', err.message);
  console.error('TWILIO_ACCOUNT_SID set:', !!TWILIO_ACCOUNT_SID);
  console.error('TWILIO_AUTH_TOKEN set:', !!TWILIO_AUTH_TOKEN);
}

// ─── Express App ───
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// CORS middleware
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─── Active Call Sessions ───
const sessions = new Map();

// ─── Health Check ───
app.get('/', (req, res) => {
  res.json({ status: 'ok', agent: 'michael', activeCalls: sessions.size, uptime: process.uptime() });
});
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy', uptime: process.uptime() });
});

// ─── GET /voice/preview — Generate a voice sample from ElevenLabs ───
app.get('/voice/preview', async (req, res) => {
  const samples = [
    "Hey there! Ready to help you book more meetings. Just fill out the form below and let's get started.",
    "Hi! I'm Michael, your AI BDR. Fill out the form and I'll show you what an AI cold call sounds like.",
    "Hey! Let me show you how AI can handle cold calls. Drop your details in the form and let's go.",
    "What's up! I'm here to help your sales team crush it. Fill in the form and I'll give you a live demo.",
    "Hi there! Want to see AI cold calling in action? Just fill out the form below and I'll call you.",
  ];

  try {
    const index = parseInt(req.query.index) || Math.floor(Math.random() * samples.length);
    const text = samples[index % samples.length];

    const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID || 'pdoiqZrWfcY60KV2vt2G'}`, {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_turbo_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    });

    if (!ttsRes.ok) {
      console.error(`[VoicePreview] ElevenLabs error: ${ttsRes.status}`);
      return res.status(502).json({ error: 'TTS generation failed' });
    }

    const audioBuffer = Buffer.from(await ttsRes.arrayBuffer());
    res.set({
      'Content-Type': 'audio/mpeg',
      'Content-Length': audioBuffer.length,
      'Cache-Control': 'public, max-age=3600',
    });
    res.send(audioBuffer);
  } catch (err) {
    console.error(`[VoicePreview] Error:`, err.message);
    res.status(500).json({ error: 'Voice preview failed' });
  }
});

// ─── POST /call/initiate — Start a call ───
app.post('/call/initiate', async (req, res) => {
  // Verify shared secret
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${CALL_SERVER_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const {
    firstName, lastName, email, phone, company,
    selling, tone, industry, targetRole,
    valueProps, commonObjections, additionalContext
  } = req.body;

  if (!phone || !firstName || !selling || !company) {
    return res.status(400).json({ error: 'Missing required fields: phone, firstName, selling, company' });
  }

  const sessionId = uuidv4();
  const systemPrompt = buildSystemPrompt({
    firstName, lastName, company, selling, tone,
    industry, targetRole, valueProps, commonObjections, additionalContext
  });

  // Create session
  const session = new CallSession({
    sessionId,
    phone,
    firstName,
    lastName,
    email,
    company,
    systemPrompt,
    context: req.body,
  });
  sessions.set(sessionId, session);

  try {
    // Determine the public URL for webhooks
    const serverUrl = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : process.env.SERVER_URL || `http://localhost:${PORT}`;

    console.log(`[${sessionId}] Server URL for webhooks: ${serverUrl}`);
    console.log(`[${sessionId}] Calling ${phone} from ${TWILIO_PHONE_NUMBER}`);
    console.log(`[${sessionId}] Webhook URL: ${serverUrl}/call/webhook/${sessionId}`);

    // Initiate outbound call via Twilio
    const call = await twilioClient.calls.create({
      to: phone,
      from: TWILIO_PHONE_NUMBER,
      url: `${serverUrl}/call/webhook/${sessionId}`,
      statusCallback: `${serverUrl}/call/status/${sessionId}`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST',
      machineDetection: 'Enable',
      timeout: 30,
    });

    session.callSid = call.sid;
    session.status = 'initiating';

    console.log(`[${sessionId}] Call initiated: ${call.sid} → ${phone} (status: ${call.status})`);

    res.json({
      sessionId,
      callSid: call.sid,
      status: 'initiating',
    });
  } catch (err) {
    console.error(`[${sessionId}] Failed to initiate call:`, err.message);
    console.error(`[${sessionId}] Full error:`, JSON.stringify(err, null, 2));
    sessions.delete(sessionId);
    res.status(500).json({ error: `Failed to initiate call: ${err.message}` });
  }
});

// ─── POST /call/webhook/:sessionId — Twilio calls this when user picks up ───
app.post('/call/webhook/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (!session) {
    console.error(`[${sessionId}] Webhook hit but no session found`);
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say('Sorry, an error occurred.');
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  const serverUrl = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `wss://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : process.env.WS_URL || `ws://localhost:${PORT}`;

  // Build TwiML to connect a bidirectional media stream
  const twiml = new twilio.twiml.VoiceResponse();
  const connect = twiml.connect();
  connect.stream({
    url: `${serverUrl}/call/media/${sessionId}`,
    name: 'michael-media',
  });

  // Keep the call alive while media stream is open
  twiml.pause({ length: 3600 });

  session.status = 'connected';
  broadcastToUI(sessionId, { type: 'status', value: 'connected' });

  console.log(`[${sessionId}] Call connected, media stream starting`);
  res.type('text/xml').send(twiml.toString());
});

// ─── POST /call/status/:sessionId — Twilio status callbacks ───
app.post('/call/status/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const { CallStatus, CallDuration } = req.body;
  const session = sessions.get(sessionId);

  if (session) {
    session.status = CallStatus;
    if (CallDuration) session.duration = parseInt(CallDuration);

    broadcastToUI(sessionId, {
      type: 'call_status',
      status: CallStatus,
      duration: CallDuration,
    });

    console.log(`[${sessionId}] Status: ${CallStatus} (${CallDuration || 0}s)`);

    if (['completed', 'busy', 'no-answer', 'canceled', 'failed'].includes(CallStatus)) {
      broadcastToUI(sessionId, {
        type: 'call_ended',
        reason: CallStatus,
        transcript: session.getFullTranscript(),
        duration: session.duration,
      });

      // Clean up after a delay
      setTimeout(() => {
        sessions.delete(sessionId);
        console.log(`[${sessionId}] Session cleaned up`);
      }, 300000); // Keep for 5 min for debrief
    }
  }

  res.sendStatus(200);
});

// ─── GET /call/session/:sessionId — Get session info ───
app.get('/call/session/:sessionId', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  res.json({
    sessionId: session.sessionId,
    status: session.status,
    transcript: session.getFullTranscript(),
    duration: session.duration,
    messageCount: session.messages.length,
  });
});

// ─── Create HTTP server ───
const server = http.createServer(app);

// ─── WebSocket Server ───
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  // Route 1: Twilio Media Stream
  const mediaMatch = path.match(/^\/call\/media\/(.+)$/);
  if (mediaMatch) {
    handleMediaStream(ws, mediaMatch[1]);
    return;
  }

  // Route 2: Browser transcript relay
  const transcriptMatch = path.match(/^\/call\/transcript\/(.+)$/);
  if (transcriptMatch) {
    handleTranscriptConnection(ws, transcriptMatch[1]);
    return;
  }

  console.log(`Unknown WebSocket path: ${path}`);
  ws.close();
});

// ─── Twilio Media Stream Handler ───
async function handleMediaStream(ws, sessionId) {
  const session = sessions.get(sessionId);
  if (!session) {
    console.error(`[${sessionId}] Media stream connected but no session`);
    ws.close();
    return;
  }

  console.log(`[${sessionId}] Twilio media stream connected`);
  session.mediaWs = ws;
  session.streamSid = null;

  // Initialize Deepgram for real-time STT
  let deepgramConnection = null;
  let isProcessingResponse = false;
  let audioQueue = []; // Queue audio until Deepgram is ready
  session.openingCooldown = true; // Suppress responses while Michael's opening line plays
  // Safety timeout — clear cooldown after 15s max to prevent frozen calls
  setTimeout(() => {
    if (session.openingCooldown) {
      session.openingCooldown = false;
      console.log(`[${sessionId}] Opening cooldown SAFETY TIMEOUT — forcibly cleared after 15s`);
    }
  }, 15000);

  // IMPORTANT: Register the message handler FIRST, before awaiting Deepgram.
  // Twilio sends 'connected' and 'start' events immediately on WebSocket open.
  // If we await Deepgram init first, we miss these events and streamSid is never set.
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);

      switch (msg.event) {
        case 'connected':
          console.log(`[${sessionId}] Media stream: connected`);
          break;

        case 'start':
          session.streamSid = msg.start.streamSid;
          console.log(`[${sessionId}] Media stream: started (streamSid: ${session.streamSid})`);

          // Guard against duplicate 'start' events triggering double intro
          if (!session.openingSent) {
            session.openingSent = true;
            setTimeout(async () => {
              await sendOpeningLine(session);
            }, 800);
          } else {
            console.warn(`[${sessionId}] Duplicate 'start' event — skipping opening`);
          }
          break;

        case 'media':
          // Forward audio to Deepgram for transcription
          if (deepgramConnection) {
            const audioData = Buffer.from(msg.media.payload, 'base64');
            processAudio(deepgramConnection, audioData);
          } else {
            // Queue audio until Deepgram is ready
            audioQueue.push(msg.media.payload);
          }
          break;

        case 'stop':
          console.log(`[${sessionId}] Media stream: stopped`);
          break;
      }
    } catch (err) {
      console.error(`[${sessionId}] Media message parse error:`, err.message);
    }
  });

  // Now initialize Deepgram (the message handler above will queue audio in the meantime)
  try {
    deepgramConnection = await initDeepgram(sessionId, {
      // Called when Deepgram produces a final transcript
      onTranscript: async (text, isFinal) => {
        if (!isFinal) {
          // Send interim results to UI for real-time feel
          broadcastToUI(sessionId, {
            type: 'user_speech_interim',
            text,
          });
          return;
        }

        if (!text.trim()) return;

        // Suppress response generation during opening cooldown (prevents double intro)
        // Still add message to transcript so nothing is lost
        if (session.openingCooldown) {
          console.log(`[${sessionId}] User speech during opening cooldown (queued, no response): "${text}"`);
          session.addMessage('user', text);
          broadcastToUI(sessionId, { type: 'user_speech', text, final: true });
          return;
        }

        console.log(`[${sessionId}] User said: "${text}"`);

        // Add to session transcript
        session.addMessage('user', text);

        // Send to UI
        broadcastToUI(sessionId, {
          type: 'user_speech',
          text,
          final: true,
        });

        // Generate Michael's response
        if (!isProcessingResponse) {
          isProcessingResponse = true;
          broadcastToUI(sessionId, { type: 'status', value: 'thinking' });

          try {
            const response = await generateResponse(
              session.systemPrompt,
              session.messages,
            );

            console.log(`[${sessionId}] Michael says: "${response}"`);
            session.addMessage('assistant', response);

            // Send text to UI
            broadcastToUI(sessionId, {
              type: 'michael_speech',
              text: response,
              final: true,
            });
            broadcastToUI(sessionId, { type: 'status', value: 'speaking' });

            // Convert to speech and play on phone
            const audioBuffer = await synthesizeSpeech(response);
            console.log(`[${sessionId}] TTS result: audioBuffer=${audioBuffer ? audioBuffer.length + ' bytes' : 'NULL'}, mediaWs=${session.mediaWs ? 'OPEN(state=' + session.mediaWs.readyState + ')' : 'NULL'}, streamSid=${session.streamSid || 'NULL'}`);
            if (audioBuffer && session.mediaWs && session.streamSid) {
              await sendAudioToTwilio(session.mediaWs, session.streamSid, audioBuffer, sessionId);
            } else {
              console.error(`[${sessionId}] SKIPPED audio send! audioBuffer=${!!audioBuffer}, mediaWs=${!!session.mediaWs}, streamSid=${!!session.streamSid}`);
            }

            // Check if meeting was booked (simple heuristic)
            if (detectMeetingBooked(response, text)) {
              session.meetingBooked = true;
              broadcastToUI(sessionId, {
                type: 'meeting_booked',
                message: 'Michael has booked a meeting!',
              });

              // Gracefully end the call after meeting is booked
              // Generate a natural closing line, send it, then hang up
              console.log(`[${sessionId}] Meeting booked! Initiating graceful call ending...`);
              setTimeout(async () => {
                try {
                  // Generate a natural closing response
                  const closingPrompt = 'The prospect just agreed to a meeting. Say a brief, natural goodbye to wrap up the call. Keep it to 1-2 sentences max. Examples: "Sounds great, I\'ll send over the calendar invite right after this. Really appreciate your time!" or "Perfect, you\'ll get the details in your inbox shortly. Thanks so much for chatting!"';
                  const closingResponse = await generateResponse(closingPrompt, session.messages);

                  if (closingResponse) {
                    session.addMessage('assistant', closingResponse);
                    broadcastToUI(sessionId, { type: 'michael_speech', text: closingResponse });
                    broadcastToUI(sessionId, { type: 'status', value: 'speaking' });

                    const closingAudio = await synthesizeSpeech(closingResponse);
                    if (closingAudio && session.mediaWs && session.streamSid) {
                      await sendAudioToTwilio(session.mediaWs, session.streamSid, closingAudio, sessionId);
                    }
                  }

                  // Wait for closing audio to play (~4 seconds), then hang up
                  setTimeout(async () => {
                    try {
                      if (session.callSid) {
                        console.log(`[${sessionId}] Hanging up call ${session.callSid} after meeting booked`);
                        await twilioClient.calls(session.callSid).update({ status: 'completed' });
                      }
                    } catch (hangupErr) {
                      console.error(`[${sessionId}] Error hanging up call:`, hangupErr.message);
                    }
                  }, 5000);
                } catch (closeErr) {
                  console.error(`[${sessionId}] Error in graceful close:`, closeErr.message);
                  // Still try to hang up even if closing line fails
                  try {
                    if (session.callSid) {
                      await twilioClient.calls(session.callSid).update({ status: 'completed' });
                    }
                  } catch (e) {}
                }
              }, 2000); // Give 2s for the current response audio to finish
            }
          } catch (err) {
            console.error(`[${sessionId}] Response generation error:`, err.message);
          } finally {
            isProcessingResponse = false;
            broadcastToUI(sessionId, { type: 'status', value: 'listening' });
          }
        }
      },

      onError: (err) => {
        console.error(`[${sessionId}] Deepgram error:`, err);
      },
    });

    // Flush any audio that was queued while Deepgram was initializing
    if (audioQueue.length > 0) {
      console.log(`[${sessionId}] Flushing ${audioQueue.length} queued audio packets to Deepgram`);
      for (const payload of audioQueue) {
        const audioData = Buffer.from(payload, 'base64');
        processAudio(deepgramConnection, audioData);
      }
      audioQueue = [];
    }
  } catch (err) {
    console.error(`[${sessionId}] Failed to init Deepgram:`, err.message);
    ws.close();
    return;
  }

  ws.on('close', () => {
    console.log(`[${sessionId}] Media stream closed`);
    if (deepgramConnection) {
      deepgramConnection.finish();
    }
  });

  ws.on('error', (err) => {
    console.error(`[${sessionId}] Media stream error:`, err.message);
  });
}

// ─── Send Michael's opening line ───
async function sendOpeningLine(session) {
  const { sessionId, context } = session;
  const firstName = context.firstName || 'there';

  // Use OpenAI to generate a natural opening
  const openingMessages = [
    { role: 'user', content: `[SYSTEM: The call has just connected. The prospect "${firstName}" has picked up the phone. Deliver your opening line. Keep it under 2 sentences. Be natural, confident, and immediately establish who you are and why you're calling.]` },
  ];

  try {
    const opening = await generateResponse(session.systemPrompt, openingMessages);
    console.log(`[${sessionId}] Michael opens: "${opening}"`);

    session.addMessage('assistant', opening);
    broadcastToUI(sessionId, {
      type: 'michael_speech',
      text: opening,
      final: true,
    });
    broadcastToUI(sessionId, { type: 'status', value: 'speaking' });

    // Synthesize and play
    const audioBuffer = await synthesizeSpeech(opening);
    console.log(`[${sessionId}] Opening TTS result: audioBuffer=${audioBuffer ? audioBuffer.length + ' bytes' : 'NULL'}, mediaWs=${session.mediaWs ? 'OPEN(state=' + session.mediaWs.readyState + ')' : 'NULL'}, streamSid=${session.streamSid || 'NULL'}`);
    if (audioBuffer && session.mediaWs && session.streamSid) {
      await sendAudioToTwilio(session.mediaWs, session.streamSid, audioBuffer, sessionId);
    } else {
      console.error(`[${sessionId}] SKIPPED opening audio send! audioBuffer=${!!audioBuffer}, mediaWs=${!!session.mediaWs}, streamSid=${!!session.streamSid}`);
    }

    broadcastToUI(sessionId, { type: 'status', value: 'listening' });

    // Estimate audio duration: mulaw 8kHz = 8000 bytes/sec
    const estimatedDurationMs = audioBuffer ? Math.ceil((audioBuffer.length / 8000) * 1000) + 1500 : 6000;
    console.log(`[${sessionId}] Opening cooldown will clear in ${estimatedDurationMs}ms`);
    setTimeout(() => {
      session.openingCooldown = false;
      console.log(`[${sessionId}] Opening cooldown cleared — now accepting user speech`);
    }, estimatedDurationMs);
  } catch (err) {
    console.error(`[${sessionId}] Failed to send opening:`, err.message);
    session.openingCooldown = false; // Clear cooldown on error so call isn't stuck
  }
}

// ─── Send audio to Twilio via Media Stream (async with pacing) ───
async function sendAudioToTwilio(mediaWs, streamSid, mulawBuffer, sessionId = 'unknown') {
  if (mediaWs.readyState !== WebSocket.OPEN) {
    console.error(`[${sessionId}] CANNOT send audio: WebSocket not open (readyState=${mediaWs.readyState})`);
    return;
  }

  // Twilio expects base64-encoded mulaw audio in 20ms chunks (160 bytes at 8kHz)
  const chunkSize = 160;
  const totalChunks = Math.ceil(mulawBuffer.length / chunkSize);
  console.log(`[${sessionId}] Sending ${mulawBuffer.length} bytes mulaw to Twilio as ${totalChunks} chunks (streamSid: ${streamSid})`);

  // Send in batches to avoid flooding the WebSocket buffer.
  // Each chunk = 20ms of audio. Send 50 chunks (~1 second of audio) per batch,
  // then yield to the event loop with a small pause.
  const BATCH_SIZE = 50;
  const BATCH_PAUSE_MS = 20; // 20ms pause between batches to let WS drain

  let sentChunks = 0;
  for (let i = 0; i < mulawBuffer.length; i += chunkSize) {
    if (mediaWs.readyState !== WebSocket.OPEN) {
      console.error(`[${sessionId}] WebSocket closed mid-send at chunk ${sentChunks}/${totalChunks}`);
      break;
    }

    const chunk = mulawBuffer.slice(i, Math.min(i + chunkSize, mulawBuffer.length));
    const payload = {
      event: 'media',
      streamSid,
      media: {
        payload: chunk.toString('base64'),
      },
    };
    try {
      mediaWs.send(JSON.stringify(payload));
      sentChunks++;
    } catch (err) {
      console.error(`[${sessionId}] Error sending chunk ${sentChunks}: ${err.message}`);
      break;
    }

    // Yield to event loop every BATCH_SIZE chunks to prevent buffer flooding
    if (sentChunks % BATCH_SIZE === 0) {
      await new Promise(resolve => setTimeout(resolve, BATCH_PAUSE_MS));
    }
  }
  console.log(`[${sessionId}] Sent ${sentChunks}/${totalChunks} audio chunks to Twilio`);
}

// ─── Browser Transcript Connection ───
function handleTranscriptConnection(ws, sessionId) {
  const session = sessions.get(sessionId);
  if (!session) {
    ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
    ws.close();
    return;
  }

  // Register this browser connection
  if (!session.uiConnections) session.uiConnections = new Set();
  session.uiConnections.add(ws);

  console.log(`[${sessionId}] Browser connected for transcript relay`);

  // Send current state
  ws.send(JSON.stringify({
    type: 'session_state',
    status: session.status,
    transcript: session.getFullTranscript(),
    messageCount: session.messages.length,
  }));

  ws.on('close', () => {
    session.uiConnections?.delete(ws);
    console.log(`[${sessionId}] Browser disconnected from transcript relay`);
  });

  ws.on('error', (err) => {
    console.error(`[${sessionId}] Browser WS error:`, err.message);
    session.uiConnections?.delete(ws);
  });
}

// ─── Broadcast to all connected browsers for a session ───
function broadcastToUI(sessionId, data) {
  const session = sessions.get(sessionId);
  if (!session?.uiConnections) return;

  const payload = JSON.stringify(data);
  for (const ws of session.uiConnections) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

// ─── Detect if a meeting was booked (requires EXPLICIT time/date confirmation) ───
// The old heuristic triggered on vague phrases like "sounds good" before a time was confirmed.
// Now we require: (1) a specific day or time was mentioned, AND (2) the prospect explicitly confirmed it.
function detectMeetingBooked(michaelText, userText) {
  const michaelLower = (michaelText || '').toLowerCase();
  const userLower = (userText || '').toLowerCase();
  const combined = `${michaelLower} ${userLower}`;

  // Step 1: A time/date reference MUST be present somewhere in the conversation.
  // Accept specific times, relative times, day-of-week mentions, etc.
  const timePatterns = [
    /\b\d{1,2}\s*(am|pm|a\.m\.|p\.m\.)\b/,
    /\b\d{1,2}:\d{2}\b/,
    /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
    /\b(tomorrow|next week|next month|this week|this friday)\b/i,
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}\b/,
    /\bin\s+\d+\s+(days?|weeks?|months?)\b/i,
    /\b(morning|afternoon|evening)\b/i,
    /\b(end of|beginning of)\s+(the\s+)?(week|month)\b/i,
  ];
  const hasTimeRef = timePatterns.some(pat => pat.test(combined));
  if (!hasTimeRef) return false;

  // Step 2: The PROSPECT must confirm in some way.
  // Accept strong scheduling phrases AND simple affirmatives when a time is on the table.
  const strongConfirmPhrases = [
    'that works', 'works for me', 'that time works', 'that day works',
    'let\'s do it', 'book it', 'let\'s book it', 'see you then',
    'looking forward', 'i\'ll be there', 'count me in', 'put me down',
    'lock it in', 'i can do that', 'i\'m available then',
    'sounds good', 'sounds great', 'sounds perfect',
  ];
  const simpleConfirms = [
    'yes', 'yeah', 'yep', 'sure', 'ok', 'okay', 'absolutely',
    'perfect', 'great', 'definitely', 'for sure', 'of course',
  ];
  const dayConfirmPatterns = [
    /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+(works|is good|is fine|is perfect)\b/,
    /\b\d{1,2}\s*(am|pm)\s+(works|is good|is fine|is perfect)\b/,
    /\byes.*(works|good|perfect|book|schedule)/,
  ];

  const prospectConfirmed = strongConfirmPhrases.some(phrase => userLower.includes(phrase))
    || simpleConfirms.some(word => {
      // Match as standalone word (not part of a larger word)
      const regex = new RegExp(`\\b${word}\\b`);
      return regex.test(userLower);
    })
    || dayConfirmPatterns.some(pat => pat.test(userLower));

  if (!prospectConfirmed) return false;

  // Step 3: Michael must have proposed or discussed the meeting (scheduling language present)
  const schedulingPhrases = [
    'how about', 'does that work', 'would that work', 'can you do',
    'let me book', 'i\'ll send', 'calendar invite',
    'schedule', 'book a time', 'set up a meeting',
    'meeting', 'demo', 'call', 'chat', 'catch up',
    'i\'ve got you down', 'pencil you in', 'block off',
    'does', 'work for you', 'available',
  ];
  const michaelProposed = schedulingPhrases.some(phrase => michaelLower.includes(phrase));

  if (!michaelProposed) return false;

  console.log(`[detectMeetingBooked] TRIGGERED — Michael: "${michaelText}", User: "${userText}"`);
  return true;
}

// ─── Start Server ───
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Michael Call Server running on port ${PORT}`);
  console.log(`Listening on 0.0.0.0:${PORT}`);
  console.log(`Process PID: ${process.pid}`);
  console.log(`Node version: ${process.version}`);
  console.log(`Memory: ${JSON.stringify(process.memoryUsage())}`);
  console.log(`Twilio Number: ${TWILIO_PHONE_NUMBER}`);
  console.log(`Allowed Origins: ${ALLOWED_ORIGINS.join(', ')}`);
  console.log(`RAILWAY_PUBLIC_DOMAIN: ${process.env.RAILWAY_PUBLIC_DOMAIN || '(not set)'}`);
  console.log(`ENV check — TWILIO_ACCOUNT_SID: ${TWILIO_ACCOUNT_SID ? 'set' : 'MISSING'}`);
  console.log(`ENV check — TWILIO_AUTH_TOKEN: ${TWILIO_AUTH_TOKEN ? 'set' : 'MISSING'}`);
  console.log(`ENV check — TWILIO_PHONE_NUMBER: ${TWILIO_PHONE_NUMBER || 'MISSING'}`);
  console.log(`ENV check — CALL_SERVER_SECRET: ${CALL_SERVER_SECRET ? 'set' : 'MISSING'}`);
  console.log(`ENV check — OPENAI_API_KEY: ${process.env.OPENAI_API_KEY ? 'set' : 'MISSING'}`);
  console.log(`ENV check — ELEVENLABS_API_KEY: ${process.env.ELEVENLABS_API_KEY ? 'set' : 'MISSING'}`);
  console.log(`ENV check — DEEPGRAM_API_KEY: ${process.env.DEEPGRAM_API_KEY ? 'set' : 'MISSING'}`);

  // Self-check: verify port is actually accepting connections
  const http = require('http');
  const testReq = http.get(`http://127.0.0.1:${PORT}/health`, (res) => {
    let body = '';
    res.on('data', d => body += d);
    res.on('end', () => {
      console.log(`SELF-CHECK OK: /health responded ${res.statusCode} — ${body}`);
    });
  });
  testReq.on('error', (err) => {
    console.error(`SELF-CHECK FAILED: Could not reach own /health endpoint — ${err.message}`);
  });
  testReq.end();
});

// Catch listen errors (e.g. port in use, permission denied)
server.on('error', (err) => {
  console.error(`SERVER LISTEN ERROR: ${err.code} — ${err.message}`);
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use!`);
  }
  // Don't exit — let Railway see the error in logs
});

// Keep-alive: prevent Node.js from exiting if all handles close
const keepAlive = setInterval(() => {
  // Log heartbeat every 5 minutes so we can see if the process is still running
  console.log(`HEARTBEAT: pid=${process.pid} uptime=${Math.floor(process.uptime())}s mem=${JSON.stringify(process.memoryUsage())}`);
}, 300000);
keepAlive.unref(); // Don't prevent graceful shutdown

// Log when process is about to exit
process.on('exit', (code) => {
  console.error(`PROCESS EXIT: code=${code} — this should NOT happen in production`);
});
process.on('SIGTERM', () => {
  console.log('SIGTERM received — Railway is stopping the container');
  process.exit(0);
});
process.on('SIGINT', () => {
  console.log('SIGINT received — shutting down');
  process.exit(0);
});
