# Michael — BDR Cold Calling Voice Agent

## Architecture Overview

Michael is fundamentally different from Sophie. Sophie runs entirely in the browser (Web Speech API for input, ElevenLabs for output). Michael makes **real phone calls** via Twilio, speaks with an ElevenLabs voice, thinks with OpenAI, and debriefs with Claude.

This requires a **two-server architecture**:

1. **Frontend + API Proxies** → Netlify (michael.mantyl.ai)
2. **Call Engine (WebSocket Server)** → Railway (persistent Node.js server)

---

## System Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                    BROWSER (michael.mantyl.ai)                    │
│                         Hosted on Netlify                         │
│                                                                   │
│  Page 1: SETUP FORM                                               │
│  ├─ First Name, Last Name, Email, Phone, Company                  │
│  ├─ What are you selling? (textarea)                              │
│  ├─ Tone selector (Professional/Friendly/Aggressive/Consultative) │
│  ├─ Industry vertical                                             │
│  └─ "Let Michael Call You" button                                 │
│                                                                   │
│  Page 2: LIVE CALL                                                │
│  ├─ Michael avatar + animated orb (speaking/listening states)     │
│  ├─ "Michael is calling you now — pick up your phone!"            │
│  ├─ Real-time transcript (WebSocket from call server)             │
│  └─ Call status indicator (ringing → connected → ended)           │
│                                                                   │
│  Page 3: DEBRIEF                                                  │
│  ├─ Full transcript                                               │
│  ├─ Meeting summary                                               │
│  ├─ Next steps                                                    │
│  └─ Sample follow-up email                                        │
└────────────┬─────────────────────────────────┬────────────────────┘
             │                                 │
     ┌───────▼───────┐               ┌────────▼─────────┐
     │ Netlify Funcs  │               │   WebSocket      │
     │ (API Proxies)  │               │   Connection     │
     │                │               │                  │
     │ /api/debrief   │               │ ws://call-server │
     │ /api/initiate  │               │ (live transcript │
     │ /api/usage     │               │  updates)        │
     └───────┬────────┘               └────────┬─────────┘
             │                                 │
             ▼                                 ▼
┌──────────────────────────────────────────────────────────────────┐
│              CALL ENGINE SERVER (Railway)                          │
│              Persistent Node.js + Express + ws                    │
│                                                                   │
│  ENDPOINTS:                                                       │
│  ├─ POST /call/initiate  — Trigger Twilio call to user's phone   │
│  ├─ POST /call/webhook   — Twilio answers, opens Media Stream    │
│  ├─ WS   /call/media     — Twilio streams raw audio (mulaw)      │
│  └─ WS   /call/transcript— Browser connects for live updates     │
│                                                                   │
│  INTERNAL PIPELINE (per call):                                    │
│                                                                   │
│  Twilio Media Stream (raw audio from phone)                       │
│       │                                                           │
│       ▼                                                           │
│  Deepgram STT (real-time transcription)                           │
│       │                                                           │
│       ▼                                                           │
│  OpenAI GPT-4o (generate Michael's response)                      │
│       │                                                           │
│       ▼                                                           │
│  ElevenLabs TTS (convert response to audio)                       │
│       │                                                           │
│       ▼                                                           │
│  Twilio Media Stream (play audio back to phone)                   │
│       │                                                           │
│       └──→ WebSocket → Browser (transcript update)                │
└──────────────────────────────────────────────────────────────────┘
             │                │                │
             ▼                ▼                ▼
      ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
      │   Twilio     │ │  Deepgram   │ │   OpenAI    │
      │   Voice API  │ │  STT API    │ │   GPT-4o    │
      │ +1(929)205-  │ │  (Stream)   │ │  (Chat)     │
      │  4750        │ │             │ │             │
      └─────────────┘ └─────────────┘ └─────────────┘
                                       ┌─────────────┐
                                       │ ElevenLabs  │
                                       │ TTS Stream  │
                                       │ Voice:      │
                                       │ pdoiqZrWfcY │
                                       │ 60KV2vt2G   │
                                       └─────────────┘
```

---

## Project Structure

```
michael-voice-agent/
├── public/                          # FRONTEND (Netlify)
│   ├── index.html                   # Single-page React app (like Sophie)
│   └── michael.png                  # Michael's avatar image
│
├── netlify/functions/               # NETLIFY SERVERLESS FUNCTIONS
│   ├── initiate-call.js             # Triggers call via call server
│   ├── debrief.js                   # Claude API for post-call analysis
│   ├── usage-tracker.js             # Usage cap (from Sophie)
│   └── error-report.js              # Error alerting (from Sophie)
│
├── call-server/                     # CALL ENGINE (Railway)
│   ├── package.json                 # Dependencies (ws, express, twilio, etc.)
│   ├── server.js                    # Main entry point
│   ├── lib/
│   │   ├── twilio-handler.js        # Twilio webhook + TwiML + Media Streams
│   │   ├── deepgram-stt.js          # Real-time speech-to-text
│   │   ├── openai-brain.js          # Conversation intelligence (GPT-4o)
│   │   ├── elevenlabs-tts.js        # Text-to-speech (Michael's voice)
│   │   ├── call-session.js          # State manager for active calls
│   │   └── transcript-relay.js      # WebSocket relay to browser
│   └── Dockerfile                   # For Railway deployment
│
├── netlify.toml                     # Build config + redirects
├── .env.example                     # All required env vars
├── package.json                     # Root package.json
└── README.md
```

---

## Environment Variables

### Netlify (.env)
```
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
ELEVENLABS_API_KEY=...
CALL_SERVER_URL=https://michael-call-server.up.railway.app
CALL_SERVER_SECRET=<shared-secret-for-auth>
```

### Railway (call-server/.env)
```
PORT=3000
TWILIO_ACCOUNT_SID=your_twilio_account_sid
TWILIO_AUTH_TOKEN=<your-auth-token>
TWILIO_PHONE_NUMBER=+19292054750
OPENAI_API_KEY=sk-...
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=pdoiqZrWfcY60KV2vt2G
DEEPGRAM_API_KEY=...
CALL_SERVER_SECRET=<shared-secret-for-auth>
ALLOWED_ORIGINS=https://michael.mantyl.ai,http://localhost:8888
```

---

## Call Flow (Step by Step)

### 1. User fills out Page 1 and clicks "Let Michael Call You"

Browser sends POST to `/api/initiate-call` (Netlify Function) with:
```json
{
  "firstName": "John",
  "lastName": "Doe",
  "email": "john@acme.com",
  "phone": "+15551234567",
  "company": "Acme Corp",
  "selling": "AI-powered sales automation platform that reduces...",
  "tone": "consultative",
  "industry": "SaaS",
  "additionalContext": "Focus on enterprise, mention ROI..."
}
```

### 2. Netlify Function forwards to Call Server

`initiate-call.js` forwards the request to Railway:
```
POST https://michael-call-server.up.railway.app/call/initiate
Authorization: Bearer <CALL_SERVER_SECRET>
```

### 3. Call Server initiates Twilio call

The call server:
- Creates a new CallSession (stores context, conversation history)
- Calls Twilio API to dial the user's phone number
- Sets the webhook URL to `/call/webhook` on the call server
- Returns a `callSid` and `sessionId` to the browser

### 4. User picks up the phone

Twilio hits `/call/webhook` on the call server. The server responds with TwiML:
```xml
<Response>
  <Connect>
    <Stream url="wss://michael-call-server.up.railway.app/call/media/{sessionId}" />
  </Connect>
</Response>
```

This opens a **bidirectional audio stream** between Twilio and the call server.

### 5. Real-time conversation loop

```
Phone audio (mulaw 8kHz) ──→ Deepgram STT ──→ User's words (text)
                                                      │
                                                      ▼
                                               OpenAI GPT-4o
                                          (with full context + history)
                                                      │
                                                      ▼
                                            Michael's response (text)
                                                      │
                                              ┌───────┴───────┐
                                              ▼               ▼
                                     ElevenLabs TTS    WebSocket → Browser
                                     (audio bytes)     (transcript update)
                                              │
                                              ▼
                                     Twilio Media Stream
                                     (play to phone)
```

### 6. Browser receives live transcript

The browser maintains a WebSocket connection to:
```
wss://michael-call-server.up.railway.app/call/transcript/{sessionId}
```

It receives JSON messages like:
```json
{ "type": "user_speech", "text": "Yeah, tell me more about that.", "final": true }
{ "type": "michael_speech", "text": "Absolutely. So what we do is...", "final": true }
{ "type": "status", "value": "michael_speaking" }
{ "type": "status", "value": "listening" }
{ "type": "call_ended", "reason": "meeting_booked" }
```

### 7. Call ends, debrief generated

When the call ends (Michael books a meeting or the conversation naturally concludes):
- Call server sends `{ type: "call_ended" }` via WebSocket
- Browser transitions to Page 3
- Browser sends the full transcript to `/api/debrief` (Netlify Function)
- Claude API generates: transcript summary, meeting details, next steps, follow-up email

---

## Michael's System Prompt Template

This is 100% dynamic based on user input. The call server constructs it at call time:

```
You are Michael, a top-performing BDR (Business Development Representative) making a cold call.

YOUR IDENTITY:
- Name: Michael
- Company: {user.company}
- Role: Business Development Representative

WHAT YOU ARE SELLING:
{user.selling}

TONE & STYLE:
{user.tone} — Adjust your communication style accordingly.

PROSPECT INFORMATION:
- Name: {user.firstName} {user.lastName}
- Company context: You are calling them as a potential buyer/decision maker

YOUR OBJECTIVE:
1. Open the call with a confident, concise introduction
2. Quickly establish relevance and hook their attention
3. Handle objections naturally and intelligently
4. Guide the conversation toward booking a meeting/demo
5. Confirm the meeting time verbally before ending

COLD CALLING RULES:
- Keep responses SHORT (2-3 sentences max). This is a phone call, not a monologue.
- Sound natural and human. Use filler words sparingly ("look", "so", "honestly").
- If they push back, acknowledge and pivot. Never be pushy or robotic.
- Mirror their energy. If they're short, be concise. If they're engaged, expand.
- Always have a clear next step in mind.
- When you've secured a meeting, confirm: "Great, how does [day] at [time] work for you?"
- After confirming the meeting, wrap up professionally and end the call.

{user.additionalContext ? `ADDITIONAL CONTEXT:\n${user.additionalContext}` : ''}

CONVERSATION FORMAT:
- You are on a PHONE CALL. Respond as if speaking out loud.
- Never use markdown, bullet points, or formatting. Just natural speech.
- Never say "as an AI" or break character. You ARE Michael.
```

---

## Audio Pipeline Details

### Twilio Media Streams → Deepgram
- Twilio sends audio as **mulaw 8kHz mono** (base64 encoded in JSON)
- Deepgram accepts this format natively via WebSocket
- Use Deepgram's `interim_results: true` for real-time partial transcripts
- Use `endpointing: 300` (300ms silence = end of utterance)
- Use `utterance_end_ms: 1000` for utterance boundary detection

### OpenAI GPT-4o Processing
- Receives finalized user utterance from Deepgram
- Maintains full conversation history in CallSession
- Returns Michael's response text
- Use `temperature: 0.85` for natural variation
- Use `max_tokens: 150` to keep responses phone-call-short

### ElevenLabs TTS → Twilio
- Use ElevenLabs **streaming TTS** endpoint for lowest latency
- Voice ID: `pdoiqZrWfcY60KV2vt2G`
- Model: `eleven_turbo_v2_5` (fastest)
- Convert output (mp3) to **mulaw 8kHz** before sending to Twilio
- Use `ffmpeg` or the `audiobuffer` approach for format conversion
- Stream audio chunks back to Twilio as base64 media messages

### Latency Budget
```
User speaks → Deepgram STT:     ~300ms
Deepgram → OpenAI GPT-4o:       ~500-800ms
OpenAI → ElevenLabs TTS:        ~300ms
ElevenLabs → Twilio playback:   ~200ms
                                ─────────
Total target:                    1.3-1.6s
```

This is acceptable for phone conversation (natural pause between speakers).

---

## Page 1: Setup Form Fields

| Field | Type | Required | Purpose |
|-------|------|----------|---------|
| First Name | text | yes | Personalization + prospect name |
| Last Name | text | yes | Personalization |
| Email | email | yes | Usage tracking |
| Phone Number | tel | yes | Twilio dials this number |
| Company | text | yes | Michael's company identity |
| What are you selling? | textarea | yes | Core pitch context |
| Tone | select | yes | Professional / Friendly / Aggressive / Consultative |
| Industry | select | no | Vertical context |
| Target title/role | text | no | Who Michael thinks he's calling |
| Key value props | textarea | no | Specific points to hit |
| Common objections | textarea | no | Pre-loaded objection handling |

---

## Page 2: Live Call UI

```
┌─────────────────────────────────────────────────────────────┐
│  [Mantyl Logo]                    Michael — BDR Agent  [●]  │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌──────────────────┐    ┌────────────────────────────────┐ │
│  │                  │    │  LIVE TRANSCRIPT                │ │
│  │   [Michael.png]  │    │                                │ │
│  │                  │    │  Michael: "Hey John, this is   │ │
│  │  ┌────────────┐  │    │  Michael from Acme Corp..."    │ │
│  │  │ Animated   │  │    │                                │ │
│  │  │ Orb/Wave   │  │    │  John: "Yeah, go ahead."      │ │
│  │  └────────────┘  │    │                                │ │
│  │                  │    │  Michael: "I'll keep this      │ │
│  │  Michael is on   │    │  quick. We help companies      │ │
│  │  the phone with  │    │  like yours..."                │ │
│  │  you right now!  │    │                                │ │
│  │                  │    │  ┌─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┐   │ │
│  │  📞 Call Active  │    │  │ ● Michael is speaking...│   │ │
│  │  02:34           │    │  └─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┘   │ │
│  └──────────────────┘    └────────────────────────────────┘ │
│                                                             │
│  [End Call Early]                                            │
└─────────────────────────────────────────────────────────────┘
```

---

## Page 3: Debrief (Claude-generated)

Tabs:
1. **Transcript** — Full conversation with speaker labels
2. **Meeting Summary** — What was discussed, outcome, meeting details
3. **Next Steps** — Recommended follow-up actions
4. **Follow-Up Email** — Draft email Michael would send post-call

Claude prompt for debrief:
```
You are analyzing a cold call transcript between Michael (BDR) and a prospect.

CONTEXT:
- Company: {company}
- Product/Service: {selling}
- Prospect: {firstName} {lastName}

TRANSCRIPT:
{fullTranscript}

Generate a structured debrief with these exact sections:

## CALL SUMMARY
[2-3 sentence overview of how the call went, key moments, and outcome]

## MEETING DETAILS
Meeting Booked: [YES/NO]
Proposed Time: [if discussed]
Prospect Interest Level: [HIGH/MEDIUM/LOW]
Key Objections Raised: [list any]

## NEXT STEPS
[Numbered list of 3-5 specific next steps]

## FOLLOW-UP EMAIL
Subject: [specific subject line]
[Professional follow-up email, 100-150 words, referencing specific points from the call]
```

---

## Step-by-Step Build Order

### Phase 1: Call Server (Railway) — Do this FIRST
1. Initialize Node.js project with dependencies
2. Build Express server with WebSocket support
3. Implement Twilio webhook handler (TwiML + Media Streams)
4. Implement Deepgram real-time STT integration
5. Implement OpenAI conversation handler
6. Implement ElevenLabs TTS with mulaw conversion
7. Implement transcript WebSocket relay to browser
8. Build CallSession state manager
9. Test locally with ngrok (Twilio needs public URL for webhooks)
10. Deploy to Railway

### Phase 2: Frontend (Netlify)
1. Build Page 1 (Setup Form) — adapt Sophie's card/form styling
2. Build Page 2 (Live Call) — Michael avatar + transcript + WebSocket
3. Build Page 3 (Debrief) — adapt Sophie's debrief tab system
4. Wire up WebSocket connection for live transcript
5. Add call status animations (ringing, connected, speaking, listening)

### Phase 3: Netlify Functions
1. Build initiate-call.js (proxy to call server)
2. Adapt debrief.js from Sophie (Claude API for post-call analysis)
3. Adapt usage-tracker.js from Sophie
4. Adapt error-report.js from Sophie

### Phase 4: Integration & Polish
1. Test full flow end-to-end
2. Configure Twilio webhook URL to Railway
3. Set up michael.mantyl.ai DNS → Netlify
4. Add error handling and fallbacks
5. Polish animations and transitions

---

## Railway Deployment

### Dockerfile (call-server/Dockerfile)
```dockerfile
FROM node:18-slim

# Install ffmpeg for audio format conversion
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
```

### Railway Setup
1. Create new project at railway.app
2. Connect GitHub repo (or deploy from CLI)
3. Set all environment variables
4. Railway auto-detects Dockerfile
5. Get public URL (e.g., `michael-call-server.up.railway.app`)
6. Configure Twilio webhook to point to this URL

---

## Key Dependencies (call-server)

```json
{
  "dependencies": {
    "express": "^4.18.2",
    "ws": "^8.16.0",
    "twilio": "^5.0.0",
    "@deepgram/sdk": "^3.5.0",
    "openai": "^4.28.0",
    "uuid": "^9.0.0",
    "cors": "^2.8.5",
    "dotenv": "^16.4.0"
  }
}
```

Note: ElevenLabs is called via direct HTTP (no SDK needed).
Audio conversion from mp3 to mulaw is done via ffmpeg child process or a lightweight npm package.

---

## Twilio Configuration

### Phone Number Setup
- Number: +1 (929) 205-4750
- Voice Webhook: `https://michael-call-server.up.railway.app/call/webhook` (POST)
- Status Callback: `https://michael-call-server.up.railway.app/call/status` (POST)

### Important: Outbound Call Setup
Michael initiates OUTBOUND calls (not inbound). The webhook is used when Twilio connects the call, not when receiving one. The flow is:

1. Call server uses Twilio REST API to create outbound call
2. `url` parameter in the API call points to the webhook
3. When the user picks up, Twilio hits the webhook
4. Webhook responds with TwiML to start Media Stream

```javascript
const call = await twilioClient.calls.create({
  to: userPhoneNumber,
  from: '+19292054750',
  url: `https://michael-call-server.up.railway.app/call/webhook/${sessionId}`,
  statusCallback: `https://michael-call-server.up.railway.app/call/status/${sessionId}`,
  statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
});
```
