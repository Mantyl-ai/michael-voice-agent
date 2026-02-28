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
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://michael-voice-agent.netlify.app,https://michael.mantyl.ai,http://localhost:8888,http://localhost:3000').split(',');

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

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
  res.json({ status: 'ok', agent: 'michael', activeCalls: sessions.size });
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
  let audioQueue = [];

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
            if (audioBuffer && session.mediaWs && session.streamSid) {
              sendAudioToTwilio(session.mediaWs, session.streamSid, audioBuffer);
            }

            // Check if meeting was booked (simple heuristic)
            if (detectMeetingBooked(response, text)) {
              session.meetingBooked = true;
              broadcastToUI(sessionId, {
                type: 'meeting_booked',
                message: 'Michael has booked a meeting!',
              });
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
  } catch (err) {
    console.error(`[${sessionId}] Failed to init Deepgram:`, err.message);
    ws.close();
    return;
  }

  // Handle incoming Twilio Media Stream messages
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

          // Send Michael's opening line after a brief pause
          setTimeout(async () => {
            await sendOpeningLine(session);
          }, 1500);
          break;

        case 'media':
          // Forward audio to Deepgram for transcription
          if (deepgramConnection) {
            const audioData = Buffer.from(msg.media.payload, 'base64');
            processAudio(deepgramConnection, audioData);
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
    if (audioBuffer && session.mediaWs && session.streamSid) {
      sendAudioToTwilio(session.mediaWs, session.streamSid, audioBuffer);
    }

    broadcastToUI(sessionId, { type: 'status', value: 'listening' });
  } catch (err) {
    console.error(`[${sessionId}] Failed to send opening:`, err.message);
  }
}

// ─── Send audio to Twilio via Media Stream ───
function sendAudioToTwilio(mediaWs, streamSid, mulawBuffer) {
  if (mediaWs.readyState !== WebSocket.OPEN) return;

  // Twilio expects base64-encoded mulaw audio in 20ms chunks (160 bytes at 8kHz)
  const chunkSize = 160;
  for (let i = 0; i < mulawBuffer.length; i += chunkSize) {
    const chunk = mulawBuffer.slice(i, Math.min(i + chunkSize, mulawBuffer.length));
    const payload = {
      event: 'media',
      streamSid,
      media: {
        payload: chunk.toString('base64'),
      },
    };
    mediaWs.send(JSON.stringify(payload));
  }
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

// ─── Detect if a meeting was booked (simple heuristic) ───
function detectMeetingBooked(michaelText, userText) {
  const combined = `${michaelText} ${userText}`.toLowerCase();
  const meetingPhrases = [
    'sounds good', 'that works', 'let\'s do it', 'book it',
    'see you then', 'looking forward', 'confirmed', 'perfect',
    'tuesday works', 'wednesday works', 'thursday works', 'friday works',
    'monday works', 'that time works', 'i\'ll be there', 'count me in',
  ];
  return meetingPhrases.some(phrase => combined.includes(phrase));
}

// ─── Start Server ───
server.listen(PORT, () => {
  console.log(`Michael Call Server running on port ${PORT}`);
  console.log(`Twilio Number: ${TWILIO_PHONE_NUMBER}`);
  console.log(`Allowed Origins: ${ALLOWED_ORIGINS.join(', ')}`);
});
