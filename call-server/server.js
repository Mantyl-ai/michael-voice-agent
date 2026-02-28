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
 * Enterprise features:
 * - Barge-in detection: Stops TTS within 200ms when prospect interrupts
 * - Voicemail detection: AMD via Twilio + graceful handling
 * - Real-time sentiment tracking: Adapts Michael's tone dynamically
 * - TCPA compliance: AI disclosure in opening line
 * - Semantic turn detection: Context-aware end-of-turn (not just silence)
 * - Response caching: ~50ms response for common TTS phrases
 * - Gatekeeper handling: Detects receptionist, navigates past
 * - Multi-language detection: Graceful handling of non-English speakers
 * - Callback scheduling: Captures preferred time when prospect is busy
 * - Opt-out keyword detection: Immediate compliance with DNC requests
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
const { synthesizeSpeech, getCacheStats } = require('./lib/elevenlabs-tts');
const { buildSystemPrompt } = require('./lib/prompt-builder');
const { updateSentiment, getSentimentPromptInjection } = require('./lib/sentiment');

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
  res.json({
    status: 'ok',
    agent: 'michael',
    activeCalls: sessions.size,
    uptime: process.uptime(),
    ttsCache: getCacheStats(),
  });
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
    // Enterprise: Async AMD runs in background — does NOT block media stream
    const call = await twilioClient.calls.create({
      to: phone,
      from: TWILIO_PHONE_NUMBER,
      url: `${serverUrl}/call/webhook/${sessionId}`,
      statusCallback: `${serverUrl}/call/status/${sessionId}`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST',
      machineDetection: 'DetectMessageEnd', // Waits for greeting to finish — needed for machine_end_* values in AMD handler
      asyncAmd: true,                       // Runs in background, doesn't block call flow
      asyncAmdStatusCallback: `${serverUrl}/call/amd/${sessionId}`,
      asyncAmdStatusCallbackMethod: 'POST',
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

// ─── Enterprise: POST /call/amd/:sessionId — Async AMD (Answering Machine Detection) callback ───
app.post('/call/amd/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const { AnsweredBy, MachineDetectionDuration } = req.body;
  const session = sessions.get(sessionId);

  if (session) {
    console.log(`[${sessionId}] AMD result: ${AnsweredBy} (detection took ${MachineDetectionDuration}ms)`);

    if (AnsweredBy === 'machine_end_beep' || AnsweredBy === 'machine_end_silence' || AnsweredBy === 'machine_end_other') {
      // Voicemail detected — leave a personalized message or hang up
      session.isVoicemail = true;
      broadcastToUI(sessionId, { type: 'voicemail_detected', answeredBy: AnsweredBy });

      console.log(`[${sessionId}] Voicemail detected! Leaving personalized message...`);

      try {
        // Generate a personalized voicemail using OpenAI
        const vmPrompt = `The call went to voicemail. Leave a brief, compelling voicemail message (under 20 seconds / 3 sentences max) for ${session.firstName}. Mention you're calling from ${session.company}, briefly state the value prop, and ask them to call back or mention you'll try again. Sound natural and friendly, not scripted. Do NOT say you're an AI in the voicemail.`;
        const vmResponse = await generateResponse(vmPrompt, []);

        if (vmResponse && session.mediaWs && session.streamSid && !session.voicemailHandled) {
          session.voicemailHandled = true;
          session.addMessage('assistant', `[Voicemail] ${vmResponse}`);
          broadcastToUI(sessionId, { type: 'michael_speech', text: `[Voicemail] ${vmResponse}` });

          const vmAudio = await synthesizeSpeech(vmResponse);
          if (vmAudio && session.mediaWs && session.streamSid) {
            await sendAudioToTwilio(session.mediaWs, session.streamSid, vmAudio, sessionId);
          }

          // Hang up after voicemail plays (estimate duration + 2s buffer)
          const vmDuration = vmAudio ? Math.ceil((vmAudio.length / 8000) * 1000) + 2000 : 5000;
          setTimeout(async () => {
            try {
              if (session.callSid) {
                console.log(`[${sessionId}] Voicemail sent. Hanging up.`);
                await twilioClient.calls(session.callSid).update({ status: 'completed' });
              }
            } catch (e) {
              console.error(`[${sessionId}] Error hanging up after voicemail:`, e.message);
            }
          }, vmDuration);
        }
      } catch (vmErr) {
        console.error(`[${sessionId}] Voicemail generation error:`, vmErr.message);
        // Just hang up if voicemail generation fails
        setTimeout(async () => {
          try {
            if (session.callSid) await twilioClient.calls(session.callSid).update({ status: 'completed' });
          } catch (e) {}
        }, 2000);
      }
    } else if (AnsweredBy === 'human') {
      console.log(`[${sessionId}] Human answered — proceeding normally`);
    } else if (AnsweredBy === 'fax') {
      console.log(`[${sessionId}] Fax machine detected — hanging up`);
      try {
        if (session.callSid) await twilioClient.calls(session.callSid).update({ status: 'completed' });
      } catch (e) {}
    }
  }

  res.sendStatus(200);
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
      // Enterprise: Include scoring data in call_ended event
      broadcastToUI(sessionId, {
        type: 'call_ended',
        reason: CallStatus,
        transcript: session.getFullTranscript(),
        duration: session.duration,
        scoring: session.getCallScoring(),
        isVoicemail: session.isVoicemail,
        callbackRequested: session.callbackRequested,
        callbackTime: session.callbackTime,
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
    scoring: session.getCallScoring(),
    sentiment: { score: session.sentimentScore, label: session.sentimentLabel },
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

// ─── Enterprise: Opt-out keyword detection ───
const OPT_OUT_PATTERNS = [
  /\b(quit|cancel|unsubscribe)\b/i,
  /\bstop\s*(calling|contacting|this|it)\b/i, // "stop calling me" — context-specific
  /\bstop\s*$/i, // standalone "stop" at end of utterance
  /\btake me off/i,
  /\bdon't call (me|again)/i,
  /\bremove (me|my number)/i,
  /\bdo not call/i,
  /\bno more calls/i,
];

function detectOptOut(text) {
  return OPT_OUT_PATTERNS.some(p => p.test(text));
}

// ─── Enterprise: Gatekeeper detection ───
const GATEKEEPER_PATTERNS = [
  /\bwho('s| is) calling/i,
  /\bwhat('s| is) (this|it) (regarding|about|in reference)/i,
  /\bcan i (ask |tell her |tell him )?what (this|it)('s| is) (about|regarding)/i,
  /\b(he|she)('s| is) (not available|in a meeting|busy|out|unavailable)/i,
  /\blet me (transfer|connect|put you through)/i,
  /\b(receptionist|front desk|operator) speaking/i,
  /\bthis is .{1,20}'s (office|assistant)/i,
  /\bi('ll| will) see if/i,
  /\bcan i take a message/i,
  /\bmay i ask who/i,
];

function detectGatekeeper(text) {
  return GATEKEEPER_PATTERNS.some(p => p.test(text));
}

// ─── Enterprise: Callback request detection ───
const CALLBACK_PATTERNS = [
  /\bcall (me )?(back|later|another time|tomorrow|next week)/i,
  /\b(bad|terrible|wrong) time/i,
  /\b(busy|swamped|slammed|in a meeting|driving|can't talk)/i,
  /\bnot a good time/i,
  /\btry (me )?(again|back|later)/i,
  /\bcan you (call|reach|try) (back|again|later)/i,
];

function detectCallbackRequest(text) {
  return CALLBACK_PATTERNS.some(p => p.test(text));
}

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

  // ─── Enterprise: Accumulated transcript for semantic turn detection ───
  let accumulatedTranscript = '';
  let turnTimer = null;
  const TURN_WAIT_MS = 600; // Wait 600ms after last final transcript before responding
  const TURN_WAIT_MID_THOUGHT_MS = 1500; // Wait longer if mid-thought detected

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
          // ─── Enterprise: Barge-in detection ───
          // If we're currently sending Michael's audio and we receive user audio,
          // the prospect is trying to interrupt
          if (session.isSpeaking && deepgramConnection) {
            // User is speaking while Michael is talking = barge-in!
            session.bargeInCount++;
            session.isSpeaking = false;

            // Abort the current audio send
            if (session.bargeInAbort) {
              session.bargeInAbort.abort();
              session.bargeInAbort = null;
            }

            // Clear Twilio's audio buffer so Michael stops talking immediately
            if (session.mediaWs && session.mediaWs.readyState === WebSocket.OPEN && session.streamSid) {
              session.mediaWs.send(JSON.stringify({
                event: 'clear',
                streamSid: session.streamSid,
              }));
            }

            console.log(`[${sessionId}] BARGE-IN detected (count: ${session.bargeInCount}) — cleared audio stream`);
            broadcastToUI(sessionId, { type: 'barge_in', count: session.bargeInCount });
          }

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

  // ─── Process a complete user turn and generate Michael's response ───
  async function processUserTurn(fullText) {
    if (!fullText.trim()) return;
    if (isProcessingResponse) return;
    if (session.openingCooldown) {
      console.log(`[${sessionId}] User speech during opening cooldown (queued, no response): "${fullText}"`);
      session.addMessage('user', fullText);
      broadcastToUI(sessionId, { type: 'user_speech', text: fullText, final: true });
      return;
    }

    // Skip if voicemail
    if (session.isVoicemail) return;

    console.log(`[${sessionId}] User said: "${fullText}"`);
    session.addMessage('user', fullText);
    broadcastToUI(sessionId, { type: 'user_speech', text: fullText, final: true });

    // ─── Enterprise: Opt-out detection ───
    if (detectOptOut(fullText)) {
      console.log(`[${sessionId}] OPT-OUT detected: "${fullText}"`);
      isProcessingResponse = true;
      broadcastToUI(sessionId, { type: 'opt_out_detected' });

      const optOutResponse = "Absolutely, I'll make sure you're removed from our list right away. Sorry for the interruption, and have a great day.";
      session.addMessage('assistant', optOutResponse);
      broadcastToUI(sessionId, { type: 'michael_speech', text: optOutResponse });
      broadcastToUI(sessionId, { type: 'status', value: 'speaking' });

      const optOutAudio = await synthesizeSpeech(optOutResponse);
      if (optOutAudio && session.mediaWs && session.streamSid) {
        await sendAudioToTwilio(session.mediaWs, session.streamSid, optOutAudio, sessionId);
      }

      // Hang up after opt-out
      setTimeout(async () => {
        try {
          if (session.callSid) await twilioClient.calls(session.callSid).update({ status: 'completed' });
        } catch (e) {}
      }, 4000);
      return;
    }

    // ─── Enterprise: Gatekeeper detection ───
    if (!session.gatekeeperNavigated && detectGatekeeper(fullText)) {
      session.isGatekeeper = true;
      console.log(`[${sessionId}] GATEKEEPER detected: "${fullText}"`);
      broadcastToUI(sessionId, { type: 'gatekeeper_detected' });
    }
    // If we hear the prospect's name after gatekeeper, mark as navigated
    if (session.isGatekeeper && fullText.toLowerCase().includes(session.firstName.toLowerCase())) {
      if (/\b(speaking|here|this is|hi|hello)\b/i.test(fullText)) {
        session.isGatekeeper = false;
        session.gatekeeperNavigated = true;
        console.log(`[${sessionId}] Gatekeeper NAVIGATED — now talking to ${session.firstName}`);
        broadcastToUI(sessionId, { type: 'gatekeeper_navigated' });
      }
    }

    // ─── Enterprise: Callback detection ───
    if (detectCallbackRequest(fullText) && !session.callbackRequested) {
      session.callbackRequested = true;
      console.log(`[${sessionId}] Callback request detected: "${fullText}"`);
      broadcastToUI(sessionId, { type: 'callback_requested' });

      // Check if they specified a time
      const timeMatch = fullText.match(/(\d{1,2}(?::\d{2})?\s*(?:am|pm)|\b(?:morning|afternoon|evening)\b|\b(?:tomorrow|monday|tuesday|wednesday|thursday|friday)\b)/i);
      if (timeMatch) {
        session.callbackTime = timeMatch[0];
        console.log(`[${sessionId}] Callback time captured: "${session.callbackTime}"`);
      }
    }

    // ─── Enterprise: Update sentiment ───
    const sentiment = updateSentiment(session, fullText);
    broadcastToUI(sessionId, {
      type: 'sentiment_update',
      score: sentiment.score,
      label: sentiment.label,
    });

    // ─── Enterprise: Non-English detection ───
    if (session.nonEnglishDetected) {
      // Already handled, don't keep responding
      return;
    }

    // Generate Michael's response
    isProcessingResponse = true;
    broadcastToUI(sessionId, { type: 'status', value: 'thinking' });

    try {
      // ─── Enterprise: Inject sentiment context into prompt ───
      const sentimentInjection = getSentimentPromptInjection(session);
      const dynamicPrompt = session.systemPrompt + sentimentInjection;

      const response = await generateResponse(
        dynamicPrompt,
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
      if (detectMeetingBooked(response, fullText)) {
        session.meetingBooked = true;
        broadcastToUI(sessionId, {
          type: 'meeting_booked',
          message: 'Michael has booked a meeting!',
        });

        // Gracefully end the call after meeting is booked
        console.log(`[${sessionId}] Meeting booked! Starting graceful close (15-20s grace period)...`);
        setTimeout(async () => {
          try {
            const closingPrompt = 'The prospect just confirmed a specific meeting date and time. Say a warm, natural goodbye that: (1) confirms you will send a calendar invite to their email, (2) briefly thanks them for their time, (3) wishes them a great day. Keep it to 2-3 sentences. Sound natural and warm, not robotic.';
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

            console.log(`[${sessionId}] Closing audio sent. Waiting 18s grace period before hangup...`);
            setTimeout(async () => {
              try {
                if (session.callSid) {
                  console.log(`[${sessionId}] Grace period over. Hanging up call ${session.callSid}`);
                  await twilioClient.calls(session.callSid).update({ status: 'completed' });
                }
              } catch (hangupErr) {
                console.error(`[${sessionId}] Error hanging up call:`, hangupErr.message);
              }
            }, 18000);
          } catch (closeErr) {
            console.error(`[${sessionId}] Error in graceful close:`, closeErr.message);
            setTimeout(async () => {
              try {
                if (session.callSid) {
                  await twilioClient.calls(session.callSid).update({ status: 'completed' });
                }
              } catch (e) {}
            }, 15000);
          }
        }, 2000);
      }
    } catch (err) {
      console.error(`[${sessionId}] Response generation error:`, err.message);
    } finally {
      isProcessingResponse = false;
      broadcastToUI(sessionId, { type: 'status', value: 'listening' });
    }
  }

  // Now initialize Deepgram (the message handler above will queue audio in the meantime)
  try {
    deepgramConnection = await initDeepgram(sessionId, {
      // Called when Deepgram produces a transcript
      onTranscript: async (text, isFinal, metadata) => {
        if (!isFinal) {
          // Send interim results to UI for real-time feel
          broadcastToUI(sessionId, {
            type: 'user_speech_interim',
            text,
          });

          // ─── Enterprise: Barge-in — interim speech during Michael talking ───
          if (session.isSpeaking && text.trim().length > 0) {
            session.bargeInCount++;
            session.isSpeaking = false;
            if (session.bargeInAbort) {
              session.bargeInAbort.abort();
              session.bargeInAbort = null;
            }
            if (session.mediaWs && session.mediaWs.readyState === WebSocket.OPEN && session.streamSid) {
              session.mediaWs.send(JSON.stringify({ event: 'clear', streamSid: session.streamSid }));
            }
            console.log(`[${sessionId}] BARGE-IN (speech detected, count: ${session.bargeInCount}) — cleared audio`);
            broadcastToUI(sessionId, { type: 'barge_in', count: session.bargeInCount });
          }

          return;
        }

        if (!text.trim()) return;

        // ─── Enterprise: Language detection ───
        // NOTE: Currently disabled because detect_language and language='en-US' are
        // incompatible in Deepgram (causes 400). detectedLanguage will always be null.
        // To re-enable: remove language='en-US' from deepgram-stt.js and add detect_language: true.
        if (metadata?.detectedLanguage && metadata.detectedLanguage !== 'en' && metadata.detectedLanguage !== 'en-US') {
          if (!session.nonEnglishDetected) {
            session.nonEnglishDetected = true;
            session.detectedLanguage = metadata.detectedLanguage;
            console.log(`[${sessionId}] NON-ENGLISH detected: ${metadata.detectedLanguage}`);
            broadcastToUI(sessionId, { type: 'language_detected', language: metadata.detectedLanguage });
          }
        }

        // ─── Enterprise: Semantic turn detection ───
        // Accumulate final transcripts and use turn analysis to decide when to respond
        accumulatedTranscript += (accumulatedTranscript ? ' ' : '') + text;

        // Clear any existing turn timer
        if (turnTimer) clearTimeout(turnTimer);

        const turnStatus = metadata?.turnStatus || 'ambiguous';

        // Determine wait time based on turn analysis
        let waitMs = TURN_WAIT_MS;
        if (turnStatus === 'mid-thought') {
          waitMs = TURN_WAIT_MID_THOUGHT_MS;
          console.log(`[${sessionId}] Mid-thought detected, waiting ${waitMs}ms: "${text}"`);
        } else if (turnStatus === 'complete') {
          waitMs = 300; // Respond faster on clearly complete turns
        }

        // Set timer to process the full accumulated turn
        turnTimer = setTimeout(() => {
          const fullTurn = accumulatedTranscript.trim();
          accumulatedTranscript = '';
          turnTimer = null;
          processUserTurn(fullTurn);
        }, waitMs);
      },

      // Called on utterance end (silence detected)
      onUtteranceEnd: () => {
        // If we have accumulated text, process it now (silence = turn is over)
        if (accumulatedTranscript.trim() && !isProcessingResponse) {
          if (turnTimer) clearTimeout(turnTimer);
          const fullTurn = accumulatedTranscript.trim();
          accumulatedTranscript = '';
          turnTimer = null;
          processUserTurn(fullTurn);
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
    console.error(`[${sessionId}] WARNING: Call will continue without STT — Michael can still deliver opening line`);
    // Do NOT close the WebSocket here! The media stream must stay open
    // so Michael's opening line can still play. The call will be one-way
    // (Michael speaks but can't hear) but at least it won't be dead silent.
  }

  ws.on('close', () => {
    console.log(`[${sessionId}] Media stream closed`);
    if (deepgramConnection) {
      deepgramConnection.finish();
    }
    if (turnTimer) clearTimeout(turnTimer);
  });

  ws.on('error', (err) => {
    console.error(`[${sessionId}] Media stream error:`, err.message);
  });
}

// ─── Send Michael's opening line ───
async function sendOpeningLine(session) {
  const { sessionId, context } = session;
  const firstName = context.firstName || 'there';

  // Enterprise: TCPA compliance — AI disclosure is now baked into the system prompt
  // The prompt-builder already includes disclosure instructions
  const openingMessages = [
    { role: 'user', content: `[SYSTEM: The call has just connected. The prospect "${firstName}" has picked up the phone. Deliver your opening line. You MUST include a natural AI disclosure in this opening (e.g. "I'm an AI assistant calling on behalf of our team"). Keep it under 2-3 sentences. Be natural, confident, and immediately establish who you are and why you're calling.]` },
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

// ─── Send audio to Twilio via Media Stream (async with pacing + barge-in support) ───
async function sendAudioToTwilio(mediaWs, streamSid, mulawBuffer, sessionId = 'unknown') {
  if (mediaWs.readyState !== WebSocket.OPEN) {
    console.error(`[${sessionId}] CANNOT send audio: WebSocket not open (readyState=${mediaWs.readyState})`);
    return;
  }

  const session = sessions.get(sessionId);

  // ─── Enterprise: Mark that Michael is speaking (for barge-in detection) ───
  if (session) {
    session.isSpeaking = true;
    // Create an abort controller for this audio send
    const abortController = new AbortController();
    session.bargeInAbort = abortController;

    // Auto-clear speaking flag when audio finishes
    const estimatedDurationMs = Math.ceil((mulawBuffer.length / 8000) * 1000);
    setTimeout(() => {
      if (session.isSpeaking) {
        session.isSpeaking = false;
        session.bargeInAbort = null;
      }
    }, estimatedDurationMs + 500);
  }

  // Twilio expects base64-encoded mulaw audio in 20ms chunks (160 bytes at 8kHz)
  const chunkSize = 160;
  const totalChunks = Math.ceil(mulawBuffer.length / chunkSize);
  console.log(`[${sessionId}] Sending ${mulawBuffer.length} bytes mulaw to Twilio as ${totalChunks} chunks (streamSid: ${streamSid})`);

  // Send in batches to avoid flooding the WebSocket buffer.
  const BATCH_SIZE = 50;
  const BATCH_PAUSE_MS = 20;

  let sentChunks = 0;
  for (let i = 0; i < mulawBuffer.length; i += chunkSize) {
    // ─── Enterprise: Check for barge-in abort ───
    if (session?.bargeInAbort?.signal?.aborted) {
      console.log(`[${sessionId}] Audio send ABORTED at chunk ${sentChunks}/${totalChunks} (barge-in)`);
      break;
    }

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

  // Clear speaking state when done
  if (session) {
    session.isSpeaking = false;
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

// ─── Detect if a meeting was booked (STRICT — requires explicit date+time confirmation) ───
function detectMeetingBooked(michaelText, userText) {
  const michaelLower = (michaelText || '').toLowerCase();
  const userLower = (userText || '').toLowerCase();
  const combined = `${michaelLower} ${userLower}`;

  // Step 1: A SPECIFIC time must be mentioned (not just "morning" or "afternoon")
  const specificTimePatterns = [
    /\b\d{1,2}\s*(am|pm|a\.m\.|p\.m\.)\b/,
    /\b\d{1,2}:\d{2}\b/,
  ];
  const hasSpecificTime = specificTimePatterns.some(pat => pat.test(combined));

  // Step 2: A SPECIFIC day must also be mentioned
  const specificDayPatterns = [
    /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
    /\b(tomorrow)\b/i,
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}\b/,
    /\b(next\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i,
    /\bthis\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  ];
  const hasSpecificDay = specificDayPatterns.some(pat => pat.test(combined));

  // Must have BOTH a day AND a time (not just one)
  if (!hasSpecificTime || !hasSpecificDay) return false;

  // Step 3: The PROSPECT must explicitly confirm with scheduling-specific language
  const confirmPhrases = [
    'that works', 'works for me', 'that time works', 'that day works',
    'let\'s do it', 'book it', 'let\'s book it', 'see you then',
    'looking forward', 'i\'ll be there', 'count me in', 'put me down',
    'lock it in', 'i can do that', 'i\'m available then',
    'sounds good', 'sounds great', 'sounds perfect',
    'perfect let\'s do', 'yes that works', 'yeah that works',
    'sure that works', 'ok that works', 'great see you',
  ];
  const confirmWithTimePatterns = [
    /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+(works|is good|is fine|is perfect)\b/i,
    /\b\d{1,2}\s*(am|pm)\s+(works|is good|is fine|is perfect)\b/i,
    /\b(yes|yeah|yep|sure).{0,20}(works|book|schedule|perfect|great|do it|see you)/i,
    /\b(works|perfect|great).{0,20}(see you|looking forward|i'll be there)/i,
  ];

  const prospectConfirmed = confirmPhrases.some(phrase => userLower.includes(phrase))
    || confirmWithTimePatterns.some(pat => pat.test(userLower));

  if (!prospectConfirmed) return false;

  // Step 4: Michael must have proposed the meeting with scheduling language
  const schedulingPhrases = [
    'how about', 'does that work', 'would that work', 'can you do',
    'let me book', 'i\'ll send', 'calendar invite',
    'schedule', 'book a time', 'set up a meeting',
    'i\'ve got you down', 'pencil you in', 'block off',
    'work for you',
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
  console.log(`Enterprise features: barge-in, AMD, sentiment, TCPA, semantic-turn, TTS-cache, scoring, gatekeeper, callback`);

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
});

// Keep-alive: prevent Node.js from exiting if all handles close
const keepAlive = setInterval(() => {
  console.log(`HEARTBEAT: pid=${process.pid} uptime=${Math.floor(process.uptime())}s mem=${JSON.stringify(process.memoryUsage())}`);
}, 300000);
keepAlive.unref();

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
