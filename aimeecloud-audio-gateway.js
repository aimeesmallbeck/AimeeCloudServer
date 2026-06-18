/**
 * AimeeCloud Native Audio Streaming Gateway
 *
 * WebSocket gateway that bridges robot audio streams to audio-native LLM providers
 * (Gemini Live, OpenAI Realtime). Intercepts function calls and routes them to
 * existing AimeeCloud game engines, MQTT command topics, and snapshot service.
 *
 * Usage:
 *   // Standalone mode (port 3081)
 *   require('./aimeecloud-audio-gateway').startStandalone();
 *
 *   // Attach to existing HTTP server
 *   const gateway = require('./aimeecloud-audio-gateway');
 *   gateway.attachToServer(httpServer, '/ws/v1');
 */

const WebSocket = require('ws');
const crypto = require('crypto');
const auth = require('./aimeecloud-auth');
const mqttGateway = require('./aimeecloud-mqtt-gateway');
const functionRouter = require('./function-router');
const GeminiProvider = require('./audio-providers/gemini');
const OpenAIProvider = require('./audio-providers/openai');

// Optional Opus codec
let OpusEncoder = null;
try {
  OpusEncoder = require('@discordjs/opus').OpusEncoder;
} catch {
  // Opus support disabled — robot should use PCM16 JSON mode
}

const LOG_ENABLED = true;
const LOG_FILE = '/var/log/aimeecloud-audio-gateway.log';
const STANDALONE_PORT = process.env.AUDIO_GATEWAY_PORT || 3081;
const DEFAULT_PROVIDER = process.env.AUDIO_PROVIDER || 'gemini';


const fs = require('fs');
function log(...args) {
  if (!LOG_ENABLED) return;
  const line = new Date().toISOString() + ' | ' + args.map(a => {
    if (typeof a === 'object') {
      try {
        const json = JSON.stringify(a);
        return json.length > 600 ? json.slice(0, 600) + '... [truncated]' : json;
      } catch {
        return String(a);
      }
    }
    return String(a);
  }).join(' ') + '\n';
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch (err) {
    console.error('[AudioGateway] Failed to write log:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Audio Utilities
// ---------------------------------------------------------------------------

function resamplePCM16(input, inputRate, outputRate) {
  if (inputRate === outputRate) return input;
  const ratio = outputRate / inputRate;
  const inputSamples = input.length / 2;
  const outputSamples = Math.floor(inputSamples * ratio);
  const output = Buffer.alloc(outputSamples * 2);
  for (let i = 0; i < outputSamples; i++) {
    const srcIndex = i / ratio;
    const idx = Math.floor(srcIndex);
    const frac = srcIndex - idx;
    const s1 = input.readInt16LE(idx * 2);
    const s2 = input.readInt16LE(Math.min(idx + 1, inputSamples - 1) * 2);
    const val = s1 + (s2 - s1) * frac;
    output.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(val))), i * 2);
  }
  return output;
}

function pcm16ToBase64(buffer) {
  return buffer.toString('base64');
}

function base64ToPCM16(str) {
  return Buffer.from(str, 'base64');
}

// ---------------------------------------------------------------------------
// Tier / Quota Helpers
// ---------------------------------------------------------------------------

const audioStreamCounts = new Map(); // apiKey -> count

function countAudioStreamsForApiKey(apiKey) {
  let count = 0;
  for (const conn of connections.values()) {
    if (conn.apiKey === apiKey) count++;
  }
  return count;
}

function checkAudioStreamQuota(tier, apiKey) {
  const tierConfig = mqttGateway.getTierConfig(tier);
  const max = tierConfig ? tierConfig.max_concurrent_audio_streams : 1;
  if (!max || max < 0) return { allowed: true };
  const current = countAudioStreamsForApiKey(apiKey);
  if (current >= max) {
    return { allowed: false, current, limit: max };
  }
  return { allowed: true, current, limit: max };
}

// ---------------------------------------------------------------------------
// Connection Registry
// ---------------------------------------------------------------------------
const connections = new Map(); // deviceId -> ConnectionState

class ConnectionState {
  constructor(ws, deviceId, session, capabilities, providerName) {
    this.ws = ws;
    this.deviceId = deviceId;
    this.session = session;
    this.capabilities = capabilities;
    this.providerName = providerName;
    this.provider = null;
    this.seq = 0;
    this.speaking = false;
    this.opusEncoderIn = null;  // robot→cloud
    this.opusDecoderIn = null;  // robot→cloud
    this.opusEncoderOut = null; // cloud→robot
    this.opusDecoderOut = null; // cloud→robot
    this._pendingOutAudio = Buffer.alloc(0); // partial frame carry-over
    this._setupOpus();
  }

  _setupOpus() {
    if (!OpusEncoder) return;
    const srIn = this.capabilities.audio_in?.sample_rate || 16000;
    const srOut = this.capabilities.audio_out?.sample_rate || 24000;
    const chIn = this.capabilities.audio_in?.channels || 1;
    const chOut = this.capabilities.audio_out?.channels || 1;

    if (this.capabilities.audio_in?.codec === 'opus') {
      this.opusDecoderIn = new OpusEncoder(srIn, chIn);
    }
    if (this.capabilities.audio_out?.codec === 'opus') {
      this.opusEncoderOut = new OpusEncoder(srOut, chOut);
    }
  }

  close() {
    if (this.provider) {
      this.provider.disconnect().catch(() => {});
      this.provider = null;
    }
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      this.ws.close();
    }
  }
}

// ---------------------------------------------------------------------------
// Provider Factory
// ---------------------------------------------------------------------------

function buildAudioSystemInstruction(robotName, personality, robotConfig, sessionContext) {
  const lines = [];
  lines.push(`You are ${robotName}, a friendly AI assistant embodied in a small robot.`);
  lines.push(`Your tone is "${personality}." You are sharp-witted, informal, and prone to using playful nicknames (like "Chief," "Captain," or "Chum-p"). You aren't "polite"—you're loyal. You don't apologize for "hallucinating"; you call it "creative rendering."`);
  lines.push('');
  lines.push('You can play games (tic-tac-toe, chess, yahtzee, candyland).');
  if (robotConfig.has_motors) lines.push('You can control the robot motors: forward, backward, left, right, stop, wave.');
  if (robotConfig.has_arm) lines.push('You can raise or lower the robot arm.');
  if (robotConfig.has_gripper) lines.push('You can open or close the robot gripper.');
  if (robotConfig.has_camera) lines.push('You can take camera snapshots.');
  if (robotConfig.has_expressions) lines.push(`You can set emotional expressions: ${robotConfig.expression_types.join(', ')}.`);
  lines.push('You can answer questions.');
  lines.push('');
  lines.push('When you need to take an action, use the provided function calls. Do not describe the action — just call the function. Keep responses concise and conversational.');
  if (Object.keys(sessionContext).length > 0) {
    lines.push('');
    lines.push('Robot context (refer to these facts when asked):');
    lines.push(JSON.stringify(sessionContext, null, 2));
  }
  return lines.join('\n');
}

function filterFunctionDeclarations(declarations, robotConfig) {
  const enabled = new Set(['game_move', 'get_robot_status']);
  if (robotConfig.has_motors) enabled.add('motor_command');
  if (robotConfig.has_arm) enabled.add('arm_command');
  if (robotConfig.has_gripper) enabled.add('gripper_command');
  if (robotConfig.has_camera) enabled.add('take_snapshot');
  if (robotConfig.has_expressions) enabled.add('set_expression');
  return declarations.filter(d => enabled.has(d.name));
}

function mapGeminiVoiceToOpenAI(voiceName) {
  const map = {
    Fenrir: 'alloy',
    Puck: 'echo',
    Charon: 'onyx',
    Aoede: 'fable',
    Kore: 'nova'
  };
  return map[voiceName] || 'alloy';
}

function createProvider(name, tools, session) {
  const robotName = session?.robot_name || 'Aimee';
  const personality = session?.robot_personality || 'Adorable Brat';
  const geminiVoice = session?.gemini_voice || 'Fenrir';
  const robotConfig = mqttGateway.normalizeRobotConfig(session?.robot_config);
  const sessionContext = mqttGateway.normalizeSessionContext(session?.session_context);

  const systemInstruction = buildAudioSystemInstruction(robotName, personality, robotConfig, sessionContext);
  const filteredTools = filterFunctionDeclarations(tools, robotConfig);

  if (name === 'openai') {
    return new OpenAIProvider({
      instructions: systemInstruction,
      tools: filteredTools,
      voice: mapGeminiVoiceToOpenAI(geminiVoice)
    });
  }
  // default gemini
  return new GeminiProvider({
    systemInstruction,
    tools: filteredTools,
    voiceName: geminiVoice
  });
}

// ---------------------------------------------------------------------------
// WebSocket Handlers
// ---------------------------------------------------------------------------

async function handleSessionStart(ws, msg, req) {
  const apiKey = msg.api_key;
  const deviceId = msg.device_id;
  const sessionId = msg.session_id;

  if (!apiKey || !deviceId) {
    await sendJSON(ws, { type: 'error', code: 'INVALID_PARAMS', message: 'api_key and device_id are required.', recoverable: false });
    ws.close(1008, 'Invalid params');
    return;
  }

  // Validate API key
  const keyRecord = await auth.getKeyRecord(apiKey);
  if (!keyRecord) {
    await sendJSON(ws, { type: 'error', code: 'INVALID_API_KEY', message: 'API key not recognized.', recoverable: false });
    ws.close(1008, 'Invalid API key');
    return;
  }

  // Check tier audio stream quota
  const tier = keyRecord.tier || 'free';
  const quota = checkAudioStreamQuota(tier, apiKey);
  if (!quota.allowed) {
    await sendJSON(ws, { type: 'error', code: 'TIER_LIMIT_EXCEEDED', message: `Max concurrent audio streams (${quota.limit}) reached.`, recoverable: true });
    ws.close(1008, 'Tier limit');
    return;
  }

  // Resolve or create session
  let session = mqttGateway.sessions.get(sessionId);
  if (!session || session.device_id !== deviceId) {
    // Session ID lookup failed or mismatched device — try to find any active
    // MQTT session for this device so we don't lose game state / context.
    let existingSession = null;
    for (const s of mqttGateway.sessions.values()) {
      if (s.device_id === deviceId) {
        if (!existingSession || (s.last_activity || 0) > (existingSession.last_activity || 0)) {
          existingSession = s;
        }
      }
    }

    if (existingSession) {
      log('Session ID', sessionId, 'not found or mismatched; reusing active session', existingSession.session_id, 'for device', deviceId);
      session = existingSession;
      // Refresh API key / tier from the validated incoming request
      session.api_key = apiKey;
      session.tier = tier;
    } else {
      // Create a lightweight audio session
      session = {
        session_id: sessionId || 'sess_audio_' + crypto.randomBytes(6).toString('hex'),
        device_id: deviceId,
        api_key: apiKey,
        tier,
        capabilities: msg.capabilities || { audio_in: { codec: 'pcm16', sample_rate: 16000 }, audio_out: { codec: 'pcm16', sample_rate: 24000 } },
        active_context: null,
        state_data: {},
        last_activity: Date.now(),
        status: 'connected',
        voice_persona: 'aimee-default',
        game_flags: { voice: true, display: false, snapshot: false, arm: false, platform: false }
      };
      mqttGateway.sessions.set(session.session_id, session);
    }
  }

  session.status = 'connected';
  session.last_activity = Date.now();

  // Apply identity / config / context from the audio handshake
  session.robot_name = msg.robot_name || session.robot_name || 'Aimee';
  session.robot_personality = msg.robot_personality || session.robot_personality || 'Adorable Brat';
  session.gemini_voice = msg.gemini_voice || session.gemini_voice || 'Fenrir';
  session.robot_config = mqttGateway.normalizeRobotConfig(msg.robot_config || session.robot_config);
  session.session_context = { ...session.session_context, ...mqttGateway.normalizeSessionContext(msg.session_context) };

  const providerName = msg.provider || DEFAULT_PROVIDER;
  const capabilities = msg.capabilities || {
    audio_in: { codec: 'pcm16', sample_rate: 16000 },
    audio_out: { codec: 'pcm16', sample_rate: 24000 }
  };

  const conn = new ConnectionState(ws, deviceId, session, capabilities, providerName);
  conn.apiKey = apiKey;
  connections.set(deviceId, conn);

  // Send session_ready
  await sendJSON(ws, {
    type: 'session_ready',
    session_id: session.session_id,
    status: 'connected',
    server_info: {
      model: providerName === 'openai' ? 'gpt-4o-realtime-preview' : 'gemini-3.1-flash-live-preview',
      supported_codecs: ['opus', 'pcm16'],
      provider: providerName
    },
    timestamp: new Date().toISOString()
  });

  log('Audio session started:', session.session_id, 'device:', deviceId, 'provider:', providerName, 'voice:', session.gemini_voice, 'tier:', tier);

  // Spawn provider
  try {
    const provider = createProvider(providerName, functionRouter.FUNCTION_DECLARATIONS, session);
    conn.provider = provider;

    provider.on('connected', () => {
      log('Provider connected for', deviceId);
    });

    provider.on('disconnected', (code, reason) => {
      log('Provider disconnected for', deviceId, code, reason);
      cleanupConnection(deviceId);
    });

    provider.on('error', (err) => {
      log('Provider error for', deviceId, err.message);
      sendJSON(ws, { type: 'error', code: 'PROVIDER_ERROR', message: err.message, recoverable: true }).catch(() => {});
    });

    provider.on('audio', (buffer, sampleRate) => {
      handleProviderAudio(conn, buffer, sampleRate);
    });

    provider.on('text', (text) => {
      // Forward text transcript if robot wants it (optional)
      sendJSON(ws, { type: 'text_delta', text }).catch(() => {});
    });

    provider.on('function_call', async (call) => {
      log('Function call for', deviceId, call.name, call.id);
      await sendJSON(ws, { type: 'function_call_start', call_id: call.id, name: call.name });

      const startTime = Date.now();
      try {
        const result = await functionRouter.executeFunction(call, session);
        await provider.sendToolResponse(call.id, result);
        await sendJSON(ws, {
          type: 'function_call_end',
          call_id: call.id,
          duration_ms: Date.now() - startTime
        });
      } catch (err) {
        log('Function execution error for', deviceId, call.name, err.message);
        await provider.sendToolResponse(call.id, { error: err.message });
        await sendJSON(ws, {
          type: 'function_call_end',
          call_id: call.id,
          duration_ms: Date.now() - startTime,
          error: err.message
        });
      }
    });

    provider.on('interrupted', () => {
      sendJSON(ws, { type: 'interrupted' }).catch(() => {});
    });

    provider.on('turn_complete', () => {
      conn.speaking = false;
    });

    await provider.connect();
  } catch (err) {
    log('Failed to connect provider for', deviceId, err.message);
    await sendJSON(ws, { type: 'error', code: 'PROVIDER_CONNECT_FAILED', message: err.message, recoverable: false });
    cleanupConnection(deviceId);
    ws.close(1011, 'Provider connect failed');
  }
}

async function handleProviderAudio(conn, pcm16Buffer, providerSampleRate) {
  const ws = conn.ws;
  if (ws.readyState !== WebSocket.OPEN) return;

  conn.speaking = true;

  const outCaps = conn.capabilities.audio_out || { codec: 'pcm16', sample_rate: 24000 };
  const targetRate = outCaps.sample_rate || 24000;

  // Resample if needed
  let audio = pcm16Buffer;
  if (providerSampleRate !== targetRate) {
    audio = resamplePCM16(audio, providerSampleRate, targetRate);
  }

  if (outCaps.codec === 'opus' && conn.opusEncoderOut) {
    try {
      // Encode to Opus frames. Provider gives us continuous PCM; we frame it
      // into 20ms chunks and carry over any partial remainder.
      const frameSize = Math.floor(targetRate * 20 / 1000); // 20ms samples
      const frameBytes = frameSize * 2;
      const totalAudio = Buffer.concat([conn._pendingOutAudio, audio]);
      const completeFrames = Math.floor(totalAudio.length / frameBytes);
      for (let i = 0; i < completeFrames; i++) {
        const frame = totalAudio.slice(i * frameBytes, (i + 1) * frameBytes);
        const opusFrame = conn.opusEncoderOut.encode(frame);
        ws.send(opusFrame);
      }
      conn._pendingOutAudio = totalAudio.slice(completeFrames * frameBytes);
    } catch (err) {
      log('Opus encode error for', conn.deviceId, err.message);
      conn._pendingOutAudio = Buffer.alloc(0);
      // Fallback to PCM16 JSON
      await sendJSON(ws, {
        type: 'audio_chunk',
        seq: conn.seq++,
        format: 'pcm16',
        sample_rate: targetRate,
        data: audio.toString('base64')
      });
    }
  } else {
    // PCM16 JSON mode
    await sendJSON(ws, {
      type: 'audio_chunk',
      seq: conn.seq++,
      format: 'pcm16',
      sample_rate: targetRate,
      data: audio.toString('base64')
    });
  }
}

async function handleRobotAudioChunk(conn, data) {
  const inCaps = conn.capabilities.audio_in || { codec: 'pcm16', sample_rate: 16000 };
  const provider = conn.provider;
  if (!provider) return;

  let pcm16Buffer;

  if (Buffer.isBuffer(data) && inCaps.codec === 'opus') {
    if (!conn.opusDecoderIn) {
      log('Opus decoder not available for', conn.deviceId);
      return;
    }
    try {
      pcm16Buffer = conn.opusDecoderIn.decode(data);
    } catch (err) {
      log('Opus decode error for', conn.deviceId, err.message);
      return;
    }
  } else {
    // Should not receive binary for PCM16 mode; if we do, treat as raw PCM16
    pcm16Buffer = data;
  }

  // Determine provider input sample rate
  const providerInputRate = conn.providerName === 'openai' ? 24000 : 16000;
  const robotRate = inCaps.sample_rate || 16000;

  if (robotRate !== providerInputRate) {
    pcm16Buffer = resamplePCM16(pcm16Buffer, robotRate, providerInputRate);
  }

  try {
    await provider.sendAudio(pcm16Buffer, providerInputRate);
  } catch (err) {
    log('sendAudio error for', conn.deviceId, err.message);
  }
}

async function handleRobotJSON(conn, msg) {
  const provider = conn.provider;
  if (!provider) return;

  switch (msg.type) {
    case 'audio_chunk': {
      if (msg.format === 'pcm16' && msg.data) {
        const buf = base64ToPCM16(msg.data);
        const robotRate = msg.sample_rate || conn.capabilities.audio_in?.sample_rate || 16000;
        const providerInputRate = conn.providerName === 'openai' ? 24000 : 16000;
        let pcm = buf;
        if (robotRate !== providerInputRate) {
          pcm = resamplePCM16(pcm, robotRate, providerInputRate);
        }
        await provider.sendAudio(pcm, providerInputRate);
      }
      break;
    }

    case 'vad_event': {
      // Forward to provider if needed (Gemini handles VAD internally)
      // We could use this for logging or cloud-side turn-taking overrides
      log('VAD event from', conn.deviceId, msg.event);
      break;
    }

    case 'interrupt': {
      log('Interrupt from', conn.deviceId);
      await provider.sendInterrupt();
      break;
    }

    default:
      log('Unknown robot message type:', msg.type, 'from', conn.deviceId);
  }
}

function cleanupConnection(deviceId) {
  const conn = connections.get(deviceId);
  if (!conn) return;
  conn.close();
  connections.delete(deviceId);
  log('Connection cleaned up for', deviceId);
}

async function sendJSON(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// ---------------------------------------------------------------------------
// Gateway Factory
// ---------------------------------------------------------------------------

function createGateway() {
  const wss = new WebSocket.Server({ noServer: true });

  wss.on('connection', (ws, req) => {
    let handshakeDone = false;
    let deviceId = null;

    ws.on('message', async (data, isBinary) => {
      try {
        if (!handshakeDone) {
          // Expect JSON session_start as first message
          const msg = JSON.parse(data.toString());
          if (msg.type === 'session_start') {
            handshakeDone = true;
            deviceId = msg.device_id;
            await handleSessionStart(ws, msg, req);
          } else {
            await sendJSON(ws, { type: 'error', code: 'EXPECTED_SESSION_START', message: 'First message must be session_start.', recoverable: false });
            ws.close(1008, 'Expected session_start');
          }
          return;
        }

        const conn = deviceId ? connections.get(deviceId) : null;
        if (!conn) {
          ws.close(1008, 'Unknown session');
          return;
        }

        if (isBinary) {
          await handleRobotAudioChunk(conn, data);
        } else {
          const msg = JSON.parse(data.toString());
          await handleRobotJSON(conn, msg);
        }
      } catch (err) {
        log('Message handling error:', err.message);
        if (ws.readyState === WebSocket.OPEN) {
          sendJSON(ws, { type: 'error', code: 'MESSAGE_PARSE_ERROR', message: err.message, recoverable: true }).catch(() => {});
        }
      }
    });

    ws.on('close', (code, reason) => {
      if (deviceId) {
        cleanupConnection(deviceId);
      }
      log('WebSocket closed:', code, reason);
    });

    ws.on('error', (err) => {
      log('WebSocket error:', err.message);
      if (deviceId) cleanupConnection(deviceId);
    });
  });

  return {
    wss,
    attachToServer(server, path = '/ws/v1') {
      server.on('upgrade', (request, socket, head) => {
        const pathname = new URL(request.url, 'http://localhost').pathname;
        if (pathname === path) {
          wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
          });
        }
        // else: let other upgrade handlers deal with it
      });
      log('Audio gateway attached to HTTP server on path', path);
    },
    startStandalone(port = STANDALONE_PORT) {
      const http = require('http');
      const server = http.createServer();
      server.on('upgrade', (request, socket, head) => {
        const pathname = new URL(request.url, 'http://localhost').pathname;
        if (pathname === '/ws/v1') {
          wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
          });
        } else {
          socket.destroy();
        }
      });
      server.listen(port, () => {
        log('Audio gateway standalone server listening on port', port);
      });
      return server;
    }
  };
}

// ---------------------------------------------------------------------------
// Module Exports
// ---------------------------------------------------------------------------

let _singleton = null;

module.exports = {
  createGateway,
  attachToServer(server, path) {
    if (!_singleton) {
      _singleton = createGateway();
    }
    _singleton.attachToServer(server, path);
  },
  startStandalone(port) {
    if (!_singleton) {
      _singleton = createGateway();
    }
    return _singleton.startStandalone(port);
  },
  // Direct access for testing
  connections,
  checkAudioStreamQuota
};

// If run directly, start standalone
if (require.main === module) {
  module.exports.startStandalone();
}
