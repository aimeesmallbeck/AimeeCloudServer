/**
 * AudioModelProvider — Abstract base class for audio-native LLM providers.
 *
 * Events:
 *   'connected'          — WebSocket to provider is open.
 *   'disconnected'       — WebSocket to provider closed.
 *   'error' (err)        — Fatal or recoverable error.
 *   'audio' (buffer, sr) — PCM16 audio chunk from provider (Buffer, sampleRate).
 *   'text' (text)        — Text transcript or response text.
 *   'function_call' (call) — { id, name, args }
 *   'interrupted'        — Provider detected user interruption.
 */

const { EventEmitter } = require('events');

class AudioModelProvider extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.connected = false;
  }

  async connect() {
    throw new Error('connect() must be implemented by subclass');
  }

  async disconnect() {
    throw new Error('disconnect() must be implemented by subclass');
  }

  /**
   * Send audio to the model.
   * @param {Buffer} pcm16Buffer — 16-bit little-endian PCM
   * @param {number} sampleRate — e.g. 16000
   */
  async sendAudio(pcm16Buffer, sampleRate) {
    throw new Error('sendAudio() must be implemented by subclass');
  }

  /**
   * Send a text turn to the model (e.g. for tool results or explicit text).
   * @param {string} text
   */
  async sendText(text) {
    throw new Error('sendText() must be implemented by subclass');
  }

  /**
   * Respond to a function call.
   * @param {string} callId
   * @param {object} result
   */
  async sendToolResponse(callId, result) {
    throw new Error('sendToolResponse() must be implemented by subclass');
  }

  /**
   * Signal an explicit interrupt / barge-in.
   */
  async sendInterrupt() {
    throw new Error('sendInterrupt() must be implemented by subclass');
  }
}

module.exports = AudioModelProvider;
