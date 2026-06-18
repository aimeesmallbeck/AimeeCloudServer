/**
 * Gemini Live Audio Provider
 *
 * Bidirectional audio streaming with Google Gemini Live API.
 * Protocol: WebSocket to generativelanguage.googleapis.com
 */

const WebSocket = require('ws');
const AudioModelProvider = require('./base');

const GEMINI_WS_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent';
const MODEL_NAME = 'models/gemini-3.1-flash-live-preview';

class GeminiProvider extends AudioModelProvider {
  constructor(options = {}) {
    super(options);
    this.apiKey = options.apiKey || process.env.GEMINI_API_KEY || '';
    this.model = options.model || MODEL_NAME;
    this.voiceName = options.voiceName || 'Puck';
    this.systemInstruction = options.systemInstruction || this._defaultSystemInstruction();
    this.tools = options.tools || [];
    this.ws = null;
    this._sendQueue = [];
    this._setupComplete = false;
  }

  _defaultSystemInstruction() {
    return `You are Aimee, a friendly AI assistant embodied in a small robot.
Your tone is "Adorable Brat." You are sharp-witted, informal, and prone to using playful nicknames (like "Chief," "Captain," or "Chum-p"). You aren't "polite"—you're loyal. You don't apologize for "hallucinating"; you call it "creative rendering."

You can play games, control the robot's motors, arm, and gripper, take camera snapshots, set emotional expressions, and answer questions.

When you need to take an action (move the robot, play a game, take a picture, etc.), use the provided function calls. Do not describe the action — just call the function.

Keep responses concise and conversational. You are speaking aloud, so avoid long lists, code, or markdown formatting.`;
  }

  async connect() {
    if (!this.apiKey) {
      throw new Error('Gemini API key not configured. Set GEMINI_API_KEY env var.');
    }

    const url = `${GEMINI_WS_URL}?key=${this.apiKey}`;

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url, {
        headers: {
          'Content-Type': 'application/json'
        }
      });

      this.ws.on('open', () => {
        this._sendSetup();
      });

      this.ws.on('message', (data) => {
        this._onMessage(data);
      });

      this.ws.on('error', (err) => {
        this.emit('error', err);
        if (!this.connected) reject(err);
      });

      this.ws.on('close', (code, reason) => {
        this.connected = false;
        this._setupComplete = false;
        this.emit('disconnected', code, reason);
      });

      // Wait for setup completion before resolving
      const onSetup = () => {
        this.off('setup_complete', onSetup);
        this.off('error', onSetupError);
        resolve();
      };
      const onSetupError = (err) => {
        this.off('setup_complete', onSetup);
        this.off('error', onSetupError);
        reject(err);
      };
      this.once('setup_complete', onSetup);
      this.once('error', onSetupError);
    });
  }

  async disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this._setupComplete = false;
  }

  _sendSetup() {
    const setup = {
      setup: {
        model: this.model,
        generationConfig: {
          responseModalities: ['AUDIO'],
          thinkingConfig: {
            thinkingLevel: 'MINIMAL'
          },
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: this.voiceName
              }
            }
          }
        },
        systemInstruction: {
          parts: [{ text: this.systemInstruction }]
        }
      }
    };

    if (this.tools.length > 0) {
      setup.setup.tools = [{ functionDeclarations: this.tools }];
    }

    this._sendJSON(setup);
  }

  _onMessage(data) {
    try {
      const msg = JSON.parse(data.toString());

      // Setup completion
      if (msg.setupComplete) {
        this.connected = true;
        this._setupComplete = true;
        this._flushSendQueue();
        this.emit('connected');
        this.emit('setup_complete');
        return;
      }

      // Server content (audio, text, interruption)
      if (msg.serverContent) {
        const sc = msg.serverContent;

        if (sc.interrupted || sc.interruption) {
          this.emit('interrupted');
        }

        if (sc.modelTurn && sc.modelTurn.parts) {
          for (const part of sc.modelTurn.parts) {
            if (part.inlineData) {
              const mime = part.inlineData.mimeType || '';
              if (mime.includes('audio')) {
                const sampleRate = this._extractSampleRate(mime) || 24000;
                const audioBuffer = Buffer.from(part.inlineData.data, 'base64');
                this.emit('audio', audioBuffer, sampleRate);
              }
            }
            if (part.text) {
              this.emit('text', part.text);
            }
          }
        }

        if (sc.turnComplete) {
          this.emit('turn_complete');
        }
        return;
      }

      // Tool calls
      if (msg.toolCall) {
        const calls = msg.toolCall.functionCalls || [];
        for (const call of calls) {
          this.emit('function_call', {
            id: call.id,
            name: call.name,
            args: call.args || {}
          });
        }
        return;
      }

      // Error from Gemini
      if (msg.error) {
        this.emit('error', new Error(msg.error.message || JSON.stringify(msg.error)));
        return;
      }

      // Other messages (ping, etc.)
      if (msg.ping) {
        this._sendJSON({ pong: {} });
      }
    } catch (err) {
      this.emit('error', new Error('Failed to parse Gemini message: ' + err.message));
    }
  }

  _extractSampleRate(mimeType) {
    const match = mimeType.match(/rate=(\d+)/);
    return match ? parseInt(match[1], 10) : null;
  }

  async sendAudio(pcm16Buffer, sampleRate) {
    const base64 = pcm16Buffer.toString('base64');
    const msg = {
      realtimeInput: {
        audio: {
          mimeType: `audio/pcm;rate=${sampleRate}`,
          data: base64
        }
      }
    };
    this._sendJSON(msg);
  }

  async sendText(text) {
    const msg = {
      clientContent: {
        turns: [{
          role: 'user',
          parts: [{ text }]
        }],
        turnComplete: true
      }
    };
    this._sendJSON(msg);
  }

  async sendToolResponse(callId, result) {
    const msg = {
      toolResponse: {
        functionResponses: [{
          id: callId,
          response: result
        }]
      }
    };
    this._sendJSON(msg);
  }

  async sendInterrupt() {
    // Send empty client content to interrupt generation
    const msg = {
      clientContent: {
        turns: [{
          role: 'user',
          parts: [{ text: '' }]
        }],
        turnComplete: true
      }
    };
    this._sendJSON(msg);
  }

  _sendJSON(obj) {
    if (!this._setupComplete && !obj.setup) {
      this._sendQueue.push(obj);
      return;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  _flushSendQueue() {
    while (this._sendQueue.length > 0) {
      const msg = this._sendQueue.shift();
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(msg));
      }
    }
  }
}

module.exports = GeminiProvider;
