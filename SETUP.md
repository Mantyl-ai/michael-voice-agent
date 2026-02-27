# Michael — Step-by-Step Setup Guide

## Prerequisites
You need accounts and API keys for:
- **Twilio** (have it) — Account SID, Auth Token, Phone Number
- **OpenAI** — API key with GPT-4o access
- **ElevenLabs** — API key + Voice ID `pdoiqZrWfcY60KV2vt2G`
- **Deepgram** — API key (free tier gives 200 hours/month)
- **Anthropic** — API key for Claude (debrief generation)
- **Railway** — For the call server (free tier works for testing)
- **Netlify** — For the frontend (already have)

---

## Step 1: Get a Deepgram API Key

1. Go to https://console.deepgram.com/signup
2. Create a free account
3. Go to API Keys → Create New Key
4. Copy the API key

---

## Step 2: Deploy the Call Server to Railway

### Option A: Via GitHub (recommended)

1. Push the `michael-voice-agent` repo to GitHub
2. Go to https://railway.app → New Project → Deploy from GitHub
3. Select the repo, set the **Root Directory** to `call-server`
4. Add environment variables (Settings → Variables):

```
PORT=3000
TWILIO_ACCOUNT_SID=your_twilio_account_sid
TWILIO_AUTH_TOKEN=<your-auth-token>
TWILIO_PHONE_NUMBER=+19292054750
OPENAI_API_KEY=sk-...
ELEVENLABS_API_KEY=<your-key>
ELEVENLABS_VOICE_ID=pdoiqZrWfcY60KV2vt2G
DEEPGRAM_API_KEY=<your-key>
CALL_SERVER_SECRET=<generate-a-random-32-char-string>
ALLOWED_ORIGINS=https://michael.mantyl.ai,http://localhost:8888,http://localhost:3000
```

5. Railway auto-detects the Dockerfile and deploys
6. Go to Settings → Networking → Generate Domain
7. Copy the public URL (e.g., `michael-call-server.up.railway.app`)

### Option B: Via Railway CLI

```bash
cd call-server
npm install
railway login
railway init
railway up
```

---

## Step 3: Update the Frontend WebSocket URL

In `public/index.html`, find this line near the top of the script:

```javascript
const CALL_SERVER_WS = window.location.hostname === 'localhost'
  ? 'ws://localhost:3001'
  : 'wss://michael-call-server.up.railway.app';
```

Replace `michael-call-server.up.railway.app` with your actual Railway domain.

---

## Step 4: Deploy Frontend to Netlify

1. Go to https://app.netlify.com → Add new site → Import existing project
2. Connect your GitHub repo
3. Build settings:
   - Base directory: (leave empty or `/`)
   - Publish directory: `public`
   - Functions directory: `netlify/functions`
4. Add environment variables:

```
ANTHROPIC_API_KEY=sk-ant-...
CALL_SERVER_URL=https://your-railway-domain.up.railway.app
CALL_SERVER_SECRET=<same-secret-as-railway>
```

5. Deploy

---

## Step 5: Configure Custom Domain

1. In Netlify: Domain settings → Add custom domain → `michael.mantyl.ai`
2. Add a CNAME record in your DNS:
   - Type: CNAME
   - Name: michael
   - Value: `your-netlify-app.netlify.app`
3. Enable HTTPS (Netlify does this automatically)

---

## Step 6: Update Twilio Webhook (IMPORTANT)

Your Twilio phone number's webhook is currently pointing to the demo URL.
You do NOT need to change the phone number's webhook because Michael makes
outbound calls (the webhook URL is passed in the API call itself).

However, if you want to test, you can verify the webhook setup:

1. Go to https://console.twilio.com/us1/develop/phone-numbers/manage/incoming
2. Click on +1 (929) 205-4750
3. The Voice webhook can stay as-is (it's for inbound calls, which we don't use)

---

## Step 7: Test Locally

### Terminal 1 — Call Server:
```bash
cd call-server
cp .env.example .env
# Fill in your actual API keys in .env
npm install
node server.js
```

### Terminal 2 — Frontend + Netlify Functions:
```bash
# In the root directory
cp .env.example .env
# Fill in your actual API keys in .env
# Set CALL_SERVER_URL=http://localhost:3000
netlify dev
```

### Testing with ngrok (required for Twilio webhooks locally):
Twilio needs a public URL to send webhooks to your local call server.

```bash
# Terminal 3
ngrok http 3000
```

Then set `SERVER_URL` in your call server's .env to the ngrok URL:
```
SERVER_URL=https://abc123.ngrok-free.app
```

### Make a test call:
1. Open http://localhost:8888 in your browser
2. Fill in the form with your real phone number
3. Click "Let Michael Call You"
4. Your phone should ring!

---

## Troubleshooting

### Call doesn't ring
- Check Twilio console for call logs: https://console.twilio.com/us1/monitor/logs/calls
- Verify phone number format (must include country code, e.g., +15551234567)
- Check Railway logs for errors
- Make sure ngrok is running if testing locally

### No transcript showing
- Open browser dev tools → Network → WebSocket connections
- Verify the WebSocket URL matches your Railway domain
- Check Railway logs for Deepgram connection errors

### Michael doesn't speak on the phone
- Check ElevenLabs API key and quota
- Check Railway logs for TTS errors
- Verify ffmpeg is installed in the Docker container (it should be)

### Debrief doesn't generate
- Check Netlify function logs: `netlify logs:function debrief`
- Verify ANTHROPIC_API_KEY is set in Netlify env vars

---

## Architecture Recap

```
Browser (Netlify)  ──POST──→  /api/initiate-call (Netlify Function)
                                    │
                                    ▼
                              Call Server (Railway)
                                    │
                         ┌──────────┼──────────┐
                         ▼          ▼          ▼
                      Twilio    Deepgram    OpenAI
                      (call)    (STT)      (brain)
                         │                     │
                         │                     ▼
                         │               ElevenLabs
                         │                 (voice)
                         │                     │
                         ◄─────────────────────┘
                         │
                    User's Phone

Browser  ──WebSocket──→  Call Server  (live transcript relay)
Browser  ──POST──→  /api/debrief (Claude API for post-call analysis)
```

---

## Cost Estimates Per Call (3-minute call)

| Service | Cost |
|---------|------|
| Twilio Voice | ~$0.04 (outbound call) |
| Deepgram STT | ~$0.01 (Nova-2 streaming) |
| OpenAI GPT-4o | ~$0.05-0.10 (multiple turns) |
| ElevenLabs TTS | ~$0.05-0.10 (Turbo v2.5) |
| Claude Haiku (debrief) | ~$0.01 |
| **Total** | **~$0.15-0.25 per call** |
