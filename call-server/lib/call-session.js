/**
 * CallSession — State manager for an active phone call.
 *
 * Tracks conversation history, transcript, status, and WebSocket connections
 * for a single Michael ↔ Prospect phone call.
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
}

module.exports = { CallSession };
