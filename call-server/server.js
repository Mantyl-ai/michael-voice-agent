/**
 * BDR AI Call Server — Built for Twilio Programmable Voice + Deepgram + OpenAI
 *
 * Handles:
 *   1. Real-time transcription (Deepgram)
 *   2. Natural language understanding (conversation history)
 *   3. Conditional response generation (OpenAI GPT-4o)
 *   4. Text-to-speech synthesis (Twilio)
 *   5. Meeting booking detection
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const twilio = require('twilio');
const { v4: uuidv4 } = require('uuid');

// Twilio config
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE = process.env.TWILIO_PHONE;
const TWILIO_TWIML_CALLBACK = process.env.TWILIO_TWIML_CALLBACK;

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const VoiceResponse = twilio.twiml.VoiceResponse;

// Deepgram config
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

// Import custom modules
const { buildSystemPrompt } = require('./lib/prompt-builder');
const { generateResponse } = require('./lib/openai-brain');

// ─── Server setup ───
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const server = http.createServer(app);
const uiWss = new WebSocket.Server({ server, path: '/ui' });
const deepgramWss = new WebSocket.Server({ noServer: true });

// ─── Session storage ───
const sessions = new Map();

class Session {
  constructor(sessionId, context) {
    this.sessionId = sessionId;
    this.context = context; // { firstName, lastName, company, phoneNumber, selling, ... }
    this.systemPrompt = null;
    this.conversationHistory = [];
    this.uiWs = null;
    this.mediaWs = null;
    this.streamSid = null;
    this.deepgramWs = null;
    this.lastMicrophoneTimestamp = 0;
    this.openingSent = false; // Guard against double-fire
  }

  addMessage(role, content) {
    this.conversationHistory.push({ role, content });
  }
}

// ─── Twilio Voice webhook (inbound call) ───
app.post('/voice', (req, res) => {
  const from = req.body.From;
  const to = req.body.To;

  // Create session
  const sessionId = uuidv4();
  const session = new Session(sessionId, {
    phoneNumber: from,
    inbound: true, // Distinguish inbound vs. outbound
  });

  // In real deployment, you'd fetch prospect data from your CRM
  // For now, we'll assume it comes from the dialer
  // (For testing, hardcode some defaults)
  session.context.firstName = 'John';
  session.context.lastName = 'Doe';
  session.context.company = 'Acme Corp';
  session.context.selling = 'Our sales automation software';
  session.context.tone = 'professional';

  sessions.set(sessionId, session);

  // Build system prompt
  session.systemPrompt = buildSystemPrompt(session.context);

  // Return TwiML to Twilio
  const twiml = new VoiceResponse();
  twiml.connect()
    .stream({
      url: `wss://${req.hostname}/media/${sessionId}`,
    });

  res.type('text/xml');
  res.send(twiml.toString());
  console.log(`[${sessionId}] Inbound call from ${from}`);
});

// ─── Outbound call endpoint ———————————————————————————————
// POST /api/call with { phoneNumber, firstName, lastName, company, selling, tone, ... }
app.post('/api/call', async (req, res) => {
  const {
    phoneNumber,
    firstName,
    lastName,
    company,
    selling,
    tone,
    industry,
    targetRole,
    valueProps,
    commonObjections,
    additionalContext,
  } = req.body;

  // Validation
  if (!phoneNumber || !firstName || !company || !selling) {
    return res.status(400).json({
      error: 'Missing required fields: phoneNumber, firstName, company, selling',
    });
  }

  // Create session
  const sessionId = uuidv4();
  const session = new Session(sessionId, {
    phoneNumber,
    firstName,
    lastName,
    company,
    selling,
    tone: tone || 'professional',
    industry,
    targetRole,
    valueProps,
    commonObjections,
    additionalContext,
    outbound: true,
  });

  // Build system prompt
  session.systemPrompt = buildSystemPrompt(session.context);
  sessions.set(sessionId, session);

  console.log(
    `[${sessionId}] Initiating call to ${phoneNumber} (${firstName} @ ${company})`
  );

  try {
    // Initiate outbound call via Twilio
    const call = await twilioClient.calls.create({
      from: TWILIO_PHONE,
      to: phoneNumber,
      url: `${TWILIO_TWIML_CALLBACK}/voice/${sessionId}`,
      machineDetection: 'Enable', // Detect voicemail
      asyncAmd: true,
      asyncAmdStatusCallback: `${TWILIO_TWIML_CALLBACK}/amd/${sessionId}`,
      asyncAmdStatusCallbackMethod: 'POST',
    });

    console.log(`[${sessionId}] Call initiated: ${call.sid}`);

    res.json({
      sessionId,
      callSid: call.sid,
      status: 'initiated',
    });
  } catch (err) {
    console.error(`[${sessionId}] Call initiation failed:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Voicemail / AMD detection callback ───
app.post('/amd/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const { AnsweredBy } = req.body;

  const session = sessions.get(sessionId);
  if (!session) return res.sendStatus(404);

  if (AnsweredBy === 'machine_start') {
    console.log(`[${sessionId}] Voicemail/IVR detected. Hanging up.`);
    session.hangupReason = 'voicemail';
  } else if (AnsweredBy === 'human') {
    console.log(`[${sessionId}] Human answered.`);
  }

  res.sendStatus(200);
});

// ─── TwiML for outbound call ───
app.get('/voice/:sessionId', (req, res) => {
  const { sessionId } = req.params;

  const twiml = new VoiceResponse();
  twiml.connect()
    .stream({
      url: `wss://${req.hostname}/media/${sessionId}`,
    });

  res.type('text/xml');
  res.send(twiml.toString());
  console.log(`[${sessionId}] TwiML returned for call`);
});

// ─── UI WebSocket (browser dashboard) ───
uiWss.on('connection', (ws) => {
  console.log('[UI] Browser connected');

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);

      if (msg.type === 'subscribe') {
        const { sessionId } = msg;
        const session = sessions.get(sessionId);
        if (session) {
          session.uiWs = ws;
          console.log(`[${sessionId}] UI subscribed`);
        }
      }
    } catch (err) {
      console.error('[UI] Message parse error:', err.message);
    }
  });

  ws.on('close', () => {
    console.log('[UI] Browser disconnected');
  });
});

function broadcastToUI(sessionId, data) {
  const session = sessions.get(sessionId);
  if (session && session.uiWs && session.uiWs.readyState === WebSocket.OPEN) {
    session.uiWs.send(JSON.stringify(data));
  }
}

// ─── Media WebSocket (Twilio audio stream) ———————————————
server.on('upgrade', (req, res, head) => {
  const match = req.url.match(/\/media\/([a-f0-9\-]+)$/);
  if (!match) {
    res.writeHead(404);
    res.end();
    return;
  }

  const sessionId = match[1];
  deepgramWss.handleUpgrade(req, res, head, (ws) => {
    handleMediaStream(sessionId, ws);
  });
});

// ─── Process incoming media stream ───
async function handleMediaStream(sessionId, ws) {
  const session = sessions.get(sessionId);
  if (!session) {
    console.error(`[${sessionId}] Session not found`);
    ws.close();
    return;
  }

  session.mediaWs = ws;
  console.log(`[${sessionId}] Media stream connected`);

  // Initialize Deepgram for this session
  let deepgramConnection = null;

  try {
    deepgramConnection = await initDeepgram(sessionId);
  } catch (err) {
    console.error(`[${sessionId}] Deepgram init failed:`, err.message);
  }

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

          // Send Michael's opening line after a brief pause (guard against double-fire)
          if (!session.openingSent) {
            session.openingSent = true;
            setTimeout(async () => {
              await sendOpeningLine(session);
            }, 800);
          }
          break;

        case 'media':
          // Forward audio to Deepgram for transcription
          if (deepgramConnection) {
            const audioData = Buffer.from(msg.media.payload, 'base64');
            processAudio(deepgramConnection, audioData);
          } else {
            // Queue audio until Deepgram is ready
            // (or re-initialize)
          }
          break;

        case 'stop':
          console.log(`[${sessionId}] Media stream: stopped`);
          if (deepgramConnection) deepgramConnection.close();
          break;
      }
    } catch (err) {
      console.error(`[${sessionId}] Media message error:`, err.message);
    }
  });

  ws.on('close', () => {
    console.log(`[${sessionId}] Media stream closed`);
    if (deepgramConnection) deepgramConnection.close();
  });

  ws.on('error', (err) => {
    console.error(`[${sessionId}] Media stream error:`, err.message);
  });
}

// ─── Send Michael's opening line ───
async function sendOpeningLine(session) {
  const { sessionId, context } = session;
  const firstName = context.firstName || 'there';

  // Use OpenAI to generate a natural opening — with shorter max_tokens for speed
  const openingMessages = [
    { role: 'user', content: `[SYSTEM: The call has just connected. "${firstName}" picked up. Deliver your opening line — 1-2 sentences only. Who you are, why you're calling.]` },
  ];

  try {
    const opening = await generateResponse(session.systemPrompt, openingMessages, { maxTokens: 80 });
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
      console.warn(`[${sessionId}] Could not play opening: missing audio or Twilio connection`);
    }
  } catch (err) {
    console.error(`[${sessionId}] sendOpeningLine error:`, err.message);
  }
}

// ─── Deepgram WebSocket initialization ───
async function initDeepgram(sessionId) {
  return new Promise((resolve, reject) => {
    const dgWs = new WebSocket(
      `wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&channels=1`,
      {
        headers: {
          Authorization: `Token ${DEEPGRAM_API_KEY}`,
        },
      }
    );

    dgWs.on('open', () => {
      console.log(`[${sessionId}] Deepgram: connected`);
      resolve(dgWs);
    });

    dgWs.on('message', (data) => {
      const session = sessions.get(sessionId);
      if (!session) return;

      try {
        const transcript = JSON.parse(data);

        if (
          transcript.type === 'Results'
          && transcript.result?.results[0]?.alternatives[0]
        ) {
          const text = transcript.result.results[0].alternatives[0].transcript;
          const isFinal = !transcript.result.is_final;

          if (text.trim()) {
            console.log(
              `[${sessionId}] Prospect: "${text}" (final: ${isFinal})`
            );

            if (isFinal) {
              // Process this as the final user turn
              handleUserSpeech(session, text);
            } else {
              // Broadcast interim for UI
              broadcastToUI(sessionId, {
                type: 'user_speech',
                text,
                final: false,
              });
            }
          }
        }
      } catch (err) {
        console.error(
          `[${sessionId}] Deepgram message parse error:`,
          err.message
        );
      }
    });

    dgWs.on('error', (err) => {
      console.error(`[${sessionId}] Deepgram error:`, err.message);
      reject(err);
    });

    dgWs.on('close', () => {
      console.log(`[${sessionId}] Deepgram: disconnected`);
    });
  });
}

// ─── Process audio and send to Deepgram ───
function processAudio(deepgramConnection, audioData) {
  if (deepgramConnection && deepgramConnection.readyState === WebSocket.OPEN) {
    deepgramConnection.send(audioData);
  }
}

// ─── Handle prospect speech ───
async function handleUserSpeech(session, userText) {
  const { sessionId } = session;
  console.log(`[${sessionId}] Handling user speech: "${userText}"`);

  // Add user message to history
  session.addMessage('user', userText);

  // Check if meeting was booked
  if (session.conversationHistory.length >= 2) {
    const lastMichael = session.conversationHistory[session.conversationHistory.length - 2]?.content || '';
    const meetingBooked = detectMeetingBooked(lastMichael, userText);
    if (meetingBooked) {
      console.log(`[${sessionId}] MEETING BOOKED — Ending call`);
      broadcastToUI(sessionId, { type: 'meeting_booked', details: 'Meeting scheduled' });

      // End call cleanly
      if (session.mediaWs) {
        session.mediaWs.close();
      }
      return;
    }
  }

  // Generate Michael's response
  try {
    broadcastToUI(sessionId, { type: 'status', value: 'thinking' });

    const michaelResponse = await generateResponse(
      session.systemPrompt,
      session.conversationHistory
    );

    console.log(`[${sessionId}] Michael responds: "${michaelResponse}"`);
    session.addMessage('assistant', michaelResponse);

    // Broadcast to UI
    broadcastToUI(sessionId, {
      type: 'michael_speech',
      text: michaelResponse,
      final: true,
    });
    broadcastToUI(sessionId, { type: 'status', value: 'speaking' });

    // Synthesize TTS and send to Twilio
    const audioBuffer = await synthesizeSpeech(michaelResponse);
    if (audioBuffer && session.mediaWs && session.streamSid) {
      await sendAudioToTwilio(
        session.mediaWs,
        session.streamSid,
        audioBuffer,
        sessionId
      );
    }
  } catch (err) {
    console.error(`[${sessionId}] Response generation error:`, err.message);
    broadcastToUI(sessionId, {
      type: 'error',
      message: err.message,
    });
  }
}

// ─── Text-to-speech (Twilio) ───
async function synthesizeSpeech(text) {
  try {
    const response = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + TWILIO_ACCOUNT_SID + '/Calls/TextToSpeech', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(TWILIO_ACCOUNT_SID + ':' + TWILIO_AUTH_TOKEN).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        Text: text,
        Voice: 'woman',
        Language: 'en-US',
      }).toString(),
    });

    if (!response.ok) {
      console.error('TTS error:', await response.text());
      return null;
    }

    return await response.arrayBuffer();
  } catch (err) {
    console.error('TTS synthesis failed:', err.message);
    return null;
  }
}

// Use Twilio's own TTS instead for simplicity
const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

async function synthesizeSpeech(text) {
  try {
    // Simple approach: use a generic TTS API or Twilio's built-in capabilities
    // For MVP, we'll mock this with a simple placeholder
    // In production, use Google Cloud TTS, Azure Speech, or ElevenLabs
    const response = await fetch('https://api.google.com/text-to-speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: { text }, voice: { languageCode: 'en-US' } }),
    }).catch(() => null);

    // For now, return a placeholder buffer
    // (In production, integrate real TTS)
    console.log(`[TTS] Synthesizing: "${text.substring(0, 50)}..."`);
    return Buffer.alloc(4000); // Placeholder
  } catch (err) {
    console.error('TTS error:', err.message);
    return null;
  }
}

// ─── Send audio back to Twilio ───
async function sendAudioToTwilio(mediaWs, streamSid, audioBuffer, sessionId) {
  if (!mediaWs || mediaWs.readyState !== WebSocket.OPEN) {
    console.warn(`[${sessionId}] Media WebSocket not open`);
    return;
  }

  // Send as mulaw audio to Twilio
  const payload = {
    event: 'media',
    streamSid,
    media: {
      payload: audioBuffer.toString('base64'),
    },
  };

  mediaWs.send(JSON.stringify(payload));
  console.log(`[${sessionId}] Sent audio to Twilio (${audioBuffer.length} bytes)`);
}

// ─── Detect if a meeting was booked (more permissive — catches ambiguous scheduling) ───
// Now catches relative times ("in 2 weeks", "next Thursday", "same time") alongside
// specific clock times. Requires prospect confirmation + Michael scheduling language.
function detectMeetingBooked(michaelText, userText) {
  const michaelLower = (michaelText || '').toLowerCase();
  const userLower = (userText || '').toLowerCase();
  const combined = `${michaelLower} ${userLower}`;

  // Step 1: A time/scheduling reference must be present (specific OR relative)
  const timePatterns = [
    // Specific clock times
    /\b\d{1,2}\s*(am|pm|a\.m\.|p\.m\.)\b/,
    /\b\d{1,2}:\d{2}\b/,
    // Day of week mentions (scheduling context)
    /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/,
    // Relative time expressions
    /\b(tomorrow|next week|next month|in \d+ (weeks?|days?|months?))\b/,
    /\b(same time|this time|that time|morning|afternoon|evening)\b/,
    // Date mentions
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}\b/,
    // Generic scheduling
    /\b(end of (the )?week|beginning of (the )?week|early next|later this)\b/,
  ];
  const hasTimeRef = timePatterns.some(pat => pat.test(combined));
  if (!hasTimeRef) return false;

  // Step 2: The PROSPECT must confirm (now more permissive — includes simple "yes/sure/yeah")
  const confirmPatterns = [
    /\b(yes|yeah|yep|yup|sure|absolutely|definitely|perfect|great)\b/,
    /\bthat works\b/, /\bworks for me\b/, /\bsounds good\b/, /\bsounds great\b/,
    /\bsounds perfect\b/, /\blet'?s do it\b/, /\bbook it\b/, /\bsee you then\b/,
    /\blooking forward\b/, /\bi'?ll be there\b/, /\bi can do\b/, /\bi'?m available\b/,
    /\bcount me in\b/, /\block it in\b/, /\bput me down\b/,
    /\b(ok|okay)\b/,
  ];
  const prospectConfirmed = confirmPatterns.some(pat => pat.test(userLower));
  if (!prospectConfirmed) return false;

  // Step 3: Michael must have proposed or confirmed the meeting
  const schedulingPhrases = [
    'how about', 'does that work', 'would that work', 'can you do',
    'let me book', 'i\'ll send', 'calendar invite', 'schedule',
    'book a time', 'set up a meeting', 'set up a call', 'pencil you in',
    'i\'ve got you down', 'got you down for', 'i\'ll put you down',
    'lock that in', 'confirmed for', 'booked for', 'see you',
    'looking forward to', 'great, so', 'perfect, so', 'meeting on',
  ];
  const michaelProposed = schedulingPhrases.some(phrase => michaelLower.includes(phrase));
  if (!michaelProposed) return false;

  console.log(`[detectMeetingBooked] TRIGGERED — Michael: "${michaelText}", User: "${userText}"`);
  return true;
}

// ─── Start Server ───
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`BDR AI server running on port ${PORT}`);
  console.log(`Media WebSocket: wss://localhost:${PORT}/media/:sessionId`);
  console.log(`UI Dashboard: http://localhost:${PORT}/ui`);
});
