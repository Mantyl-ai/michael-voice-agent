/**
 * CallSession — State manager for an active phone call.
 *
 * Tracks conversation history, transcript, status, and WebSocket connections
 * for a single Michael ↔ Prospect phone call.
 *
 * Enterprise features:
 * - Barge-in detection (isSpeaking flag + abort controller)
 * - Sentiment tracking (running score + history)
 * - Call scoring (talk-time ratio, objection count, qualification depth)
 * - Gatekeeper detection
 * - Callback scheduling
 * - Language detection
 */

class CallSession {
  constructor({ sessionId, phone, firstName, lastName, email, company, systemPrompt, context }) {
    this.sessionId = sessionId;
    this.phone = phone;
    this.firstName = firstName;
    this.lastName = lastName;
    this.email = email;
    this.company = company;
    this.systemPrompt = systemPrompt;
    this.context = context;

    // Call state
    this.callSid = null;
    this.streamSid = null;
    this.status = 'pending'; // pending → initiating → ringing → connected → completed
    this.duration = 0;
    this.meetingBooked = false;
    this.createdAt = Date.now();

    // Conversation history (OpenAI format)
    this.messages = [];

    // Raw transcript (for display)
    this.transcript = [];

    // WebSocket connections
    this.mediaWs = null;       // Twilio Media Stream
    this.uiConnections = new Set(); // Browser connections

    // ─── Enterprise: Barge-in detection ───
    this.isSpeaking = false;       // true when Michael's TTS audio is being sent
    this.speakingStartedAt = 0;    // timestamp when current audio playback started (for grace period)
    this.bargeInAbort = null;      // AbortController to cancel mid-send audio
    this.bargeInCount = 0;         // how many times prospect interrupted

    // ─── Enterprise: Sentiment tracking ───
    this.sentimentScore = 0;       // running score: -10 (hostile) to +10 (enthusiastic)
    this.sentimentHistory = [];    // [{turn, score, label}]
    this.sentimentLabel = 'neutral'; // current: hostile, negative, neutral, positive, enthusiastic

    // ─── Enterprise: Call scoring ───
    this.michaelWordCount = 0;
    this.prospectWordCount = 0;
    this.objectionCount = 0;
    this.qualificationDepth = 0;   // 0-5 based on BANT qualification
    this.qualificationChecklist = { budget: false, authority: false, need: false, timeline: false };

    // ─── Enterprise: Gatekeeper detection ───
    this.isGatekeeper = false;     // true if we detect a receptionist/assistant
    this.gatekeeperNavigated = false;

    // ─── Enterprise: Callback scheduling ───
    this.callbackRequested = false;
    this.callbackTime = null;      // captured preferred callback time

    // ─── Enterprise: Language detection ───
    this.detectedLanguage = 'en';
    this.nonEnglishDetected = false;

    // ─── Enterprise: Voicemail detection ───
    this.isVoicemail = false;
    this.voicemailHandled = false;

    // ─── Opening line guard ───
    this.openingSent = false;        // prevents duplicate opening on double 'start' event
    this.openingCooldown = false;    // suppresses user turn processing while opening plays
  }

  addMessage(role, content) {
    // OpenAI format
    this.messages.push({ role, content });

    // Display transcript
    this.transcript.push({
      speaker: role === 'assistant' ? 'Michael' : this.firstName || 'Prospect',
      text: content,
      timestamp: Date.now(),
    });

    // ─── Enterprise: Track word counts for talk-time ratio ───
    const wordCount = (content || '').split(/\s+/).filter(Boolean).length;
    if (role === 'assistant') {
      this.michaelWordCount += wordCount;
    } else {
      this.prospectWordCount += wordCount;
    }

    // ─── Enterprise: Track objections ───
    if (role === 'user') {
      const objectionPatterns = [
        /not interested/i, /no thanks/i, /we're good/i, /don't need/i,
        /too expensive/i, /no budget/i, /bad time/i, /busy right now/i,
        /already have/i, /using .+ competitor/i, /send me an email/i,
        /take me off/i, /don't call/i, /how did you get/i,
      ];
      if (objectionPatterns.some(p => p.test(content))) {
        this.objectionCount++;
      }

      // Track qualification depth (BANT)
      if (/budget|cost|price|afford|spend|invest/i.test(content)) this.qualificationChecklist.budget = true;
      if (/decision|approve|sign off|manager|boss|ceo|cto/i.test(content)) this.qualificationChecklist.authority = true;
      if (/need|problem|challenge|pain|struggle|issue/i.test(content)) this.qualificationChecklist.need = true;
      if (/when|timeline|quarter|month|week|soon|urgency/i.test(content)) this.qualificationChecklist.timeline = true;
      this.qualificationDepth = Object.values(this.qualificationChecklist).filter(Boolean).length;
    }
  }

  getFullTranscript() {
    return this.transcript.map(t => ({
      speaker: t.speaker,
      text: t.text,
      timestamp: t.timestamp,
    }));
  }

  getTranscriptText() {
    return this.transcript
      .map(t => `${t.speaker}: ${t.text}`)
      .join('\n');
  }

  /**
   * Get call scoring data for debrief
   */
  getCallScoring() {
    const totalWords = this.michaelWordCount + this.prospectWordCount;
    const talkRatio = totalWords > 0 ? Math.round((this.prospectWordCount / totalWords) * 100) : 0;

    // Ideal talk ratio: prospect should talk 60-70% of the time
    let talkRatioScore = 0;
    if (talkRatio >= 55 && talkRatio <= 75) talkRatioScore = 5;
    else if (talkRatio >= 40 && talkRatio <= 80) talkRatioScore = 3;
    else talkRatioScore = 1;

    // Objection handling score: higher if objections were raised AND call continued
    const messageCount = this.messages.length;
    let objectionScore = 5; // perfect if no objections
    if (this.objectionCount > 0) {
      // If call continued for 4+ exchanges after objections, handled well
      const messagesAfterFirstObjection = messageCount - (this.objectionCount * 2);
      objectionScore = messagesAfterFirstObjection > 4 ? 4 : messagesAfterFirstObjection > 2 ? 3 : 1;
    }

    // Meeting conversion
    const meetingScore = this.meetingBooked ? 5 : this.callbackRequested ? 3 : 1;

    // Sentiment trajectory
    let sentimentScore = 3;
    if (this.sentimentHistory.length >= 2) {
      const first = this.sentimentHistory[0]?.score || 0;
      const last = this.sentimentHistory[this.sentimentHistory.length - 1]?.score || 0;
      if (last > first + 2) sentimentScore = 5;
      else if (last > first) sentimentScore = 4;
      else if (last === first) sentimentScore = 3;
      else sentimentScore = 2;
    }

    const overallScore = Math.round((talkRatioScore + objectionScore + meetingScore + sentimentScore + this.qualificationDepth) / 5 * 20);

    return {
      overallScore: Math.min(100, Math.max(0, overallScore)),
      talkRatio: { prospectPercent: talkRatio, michaelPercent: 100 - talkRatio, score: talkRatioScore },
      objectionHandling: { count: this.objectionCount, score: objectionScore },
      meetingConversion: { booked: this.meetingBooked, callbackRequested: this.callbackRequested, score: meetingScore },
      sentimentTrajectory: { history: this.sentimentHistory, finalLabel: this.sentimentLabel, score: sentimentScore },
      qualificationDepth: { checklist: this.qualificationChecklist, depth: this.qualificationDepth, score: this.qualificationDepth },
      bargeInCount: this.bargeInCount,
      exchangeCount: Math.floor(messageCount / 2),
    };
  }
}

module.exports = { CallSession };
