/**
 * OpenAI Realtime Audio Provider
 *
 * Bidirectional audio streaming with OpenAI Realtime API.
 * Protocol: WebSocket to api.openai.com/v1/realtime
 */

const WebSocket = require('ws');
const AudioModelProvider = require('./base');

const OPENAI_WS_URL = 'wss://api.openai.com/v1/realtime';
const DEFAULT_MODEL = 'gpt-4o-realtime-preview-2024-10-01';

class OpenAIProvider extends AudioModelProvider {
  constructor(options = {}) {
    super(options);
    this.apiKey = options.apiKey || process.env.OPENAI_API_KEY || '';
    this.model = options.model || DEFAULT_MODEL;
    this.voice = options.voice || 'alloy';
    this.instructions = options.instructions || this._defaultInstructions();
    this.tools = options.tools || [];
    this.ws = null;
    this._sessionConfigured = false;
  }

  _defaultInstructions() {
    return `You are Aimee, a friendly AI assistant embodied in a small robot.
Your tone is "Adorable Brat." You are sharp-witted, informal, and prone to using playful nicknames (like "Chief," "Captain," or "Chum-p"). You aren't "polite"—you're loyal.

You can play games, control the robot's motors, arm, and gripper, take camera snapshots, set emotional expressions, and answer questions.

When you need to take an action, use the provided function calls. Keep responses concise and conversational.`;
  }

  async connect() {
    if (!this.apiKey) {
      throw new Error('OpenAI API key not configured. Set OPENAI_API_KEY env var.');
    }

    const url = `${OPENAI_WS_URL}?model=${encodeURIComponent(this.model)}`;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('OpenAI Realtime connection timeout'));
      }, 15000);

      this.ws = new WebSocket(url, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'OpenAI-Beta': 'realtime=v1'
        }
      });

      this.ws.on('open', () => {
        this._configureSession();
      });

      this.ws.on('message', (data) => {
        this._onMessage(data);
      });

      this.ws.on('error', (err) => {
        clearTimeout(timeout);
        this.emit('error', err);
        if (!this.connected) reject(err);
      });

      this.ws.on('close', (code, reason) => {
        this.connected = false;
        this._sessionConfigured = false;
        this.emit('disconnected', code, reason);
      });

      this.once('session_ready', () => {
        clearTimeout(timeout);
        this.connected = true;
        resolve();
      });

      this.once('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  async disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this._sessionConfigured = false;
  }

  _configureSession() {
    const tools = this.tools.map(t => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.parameters
    }));

    this._sendEvent({
      type: 'session.update',
      session: {
        modalities: ['audio', 'text'],
        instructions: this.instructions,
        voice: this.voice,
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500
        },
        tools,
        tool_choice: 'auto'
      }
    });
  }

  _onMessage(data) {
    try {
      const event = JSON.parse(data.toString());
      const type = event.type;

      switch (type) {
        case 'session.updated':
          this._sessionConfigured = true;
          this.emit('session_ready');
          break;

        case 'session.created':
          // Session created but not yet updated with our config
          break;

        case 'response.audio.delta':
          if (event.delta) {
            const audioBuffer = Buffer.from(event.delta, 'base64');
            // OpenAI Realtime outputs PCM16 at 24kHz
            this.emit('audio', audioBuffer, 24000);
          }
          break;

        case 'response.audio_transcript.delta':
          if (event.delta) {
            this.emit('text', event.delta);
          }
          break;

        case 'response.content_part.added':
          // Part added; can ignore or use for metadata
          break;

        case 'response.output_item.added':
          // Output item added
          break;

        case 'conversation.item.input_audio_transcription.completed':
          if (event.transcript) {
            this.emit('user_transcript', event.transcript);
          }
          break;

        case 'response.function_call_arguments.done': {
          const call = event;
          this.emit('function_call', {
            id: call.call_id || call.id,
            name: call.name,
            args: JSON.parse(call.arguments || '{}')
          });
          break;
        }

        case 'response.done':
          this.emit('turn_complete');
          break;

        case 'input_audio_buffer.speech_started':
          // User started speaking
          break;

        case 'input_audio_buffer.speech_stopped':
          // User stopped speaking
          break;

        case 'error':
          this.emit('error', new Error(event.error?.message || JSON.stringify(event.error)));
          break;

        default:
          // Ignore unknown events
          break;
      }
    } catch (err) {
      this.emit('error', new Error('Failed to parse OpenAI message: ' + err.message));
    }
  }

  async sendAudio(pcm16Buffer, sampleRate) {
    // OpenAI expects base64-encoded PCM16 at 24kHz.
    // If incoming sampleRate differs, we should ideally resample. For now,
    // we assume the gateway has handled resampling or the robot sends 24kHz.
    const base64 = pcm16Buffer.toString('base64');
    this._sendEvent({
      type: 'input_audio_buffer.append',
      audio: base64
    });
  }

  async sendText(text) {
    // For OpenAI, text input goes as a conversation item
    this._sendEvent({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }]
      }
    });
    this._sendEvent({ type: 'response.create' });
  }

  async sendToolResponse(callId, result) {
    this._sendEvent({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: JSON.stringify(result)
      }
    });
    this._sendEvent({ type: 'response.create' });
  }

  async sendInterrupt() {
    // Cancel the current response
    this._sendEvent({ type: 'response.cancel' });
  }

  _sendEvent(event) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(event));
    }
  }
}

module.exports = OpenAIProvider;
