const mqtt = require('mqtt');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const auth = require('./aimeecloud-auth');
const gameCreationAgent = require('./game-creation-agent/agent');

const SESSION_TTL = 600 * 1000; // 10 minutes in ms
const MQTT_BROKER = 'mqtt://127.0.0.1:1883';
const LOG_ENABLED = true;
const LOG_FILE = '/var/log/aimeecloud-mqtt-gateway.log';

function log(...args) {
  if (!LOG_ENABLED) return;
  const line = new Date().toISOString() + ' | ' + args.map(a => {
    if (typeof a === 'object') {
      try {
        const json = JSON.stringify(a);
        return json.length > 800 ? json.slice(0, 800) + '... [truncated]' : json;
      } catch {
        return String(a);
      }
    }
    return String(a);
  }).join(' ') + '\n';
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch (err) {
    console.error('Failed to write to log file:', err.message, line.trim());
  }
}

// ---------------------------------------------------------------------------
// Vision Analysis Helper
// ---------------------------------------------------------------------------
async function analyzeImageWithVisionLLM(base64Image, prompt) {
  const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
  if (!OPENROUTER_API_KEY) {
    return 'Vision analysis skipped: OPENROUTER_API_KEY not set.';
  }
  const fullPrompt = prompt || 'Describe what you see in this image in detail, including object colors and positions.';
  const postData = JSON.stringify({
    model: 'google/gemini-2.5-flash-lite',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: fullPrompt },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
        ]
      }
    ],
    max_tokens: 1024
  });

  const options = {
    hostname: 'openrouter.ai',
    path: '/api/v1/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Length': Buffer.byteLength(postData)
    }
  };

  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          resolve(data.choices?.[0]?.message?.content || 'No analysis available.');
        } catch {
          resolve('No analysis available.');
        }
      });
    });
    req.on('error', () => resolve('No analysis available.'));
    req.write(postData);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Expression Command Builder
// ---------------------------------------------------------------------------
function buildExpressionCommand(name, options = {}) {
  return {
    type: 'expression',
    name,
    duration_ms: options.duration_ms || 0,
    priority: options.priority || 'normal',
    params: options.params || {}
  };
}

function detectNegativeSentiment(text) {
  const negativeWords = ['sad','sorry','unfortunately','bad','wrong','fail','error','lost','hate','angry','upset','disappointed','unhappy','missed','broke','worst','terrible','awful','no good','not working','doesn\'t work','can\'t','won\'t','never'];
  const t = String(text || '').toLowerCase();
  return negativeWords.some(w => t.includes(w));
}

function isPoliteFiller(text) {
  const t = String(text || '').toLowerCase().trim();
  return /^(thank you|thanks|thx|thank u|ty|you'?re welcome|your welcome|youre welcome|ok|okay|k|kk|uh[- ]?huh|mm[- ]?hmm|mhm|hmm|hm|no problem|np|no prob|sure|alright|all right|right|got it|gotcha|understood|understand)[.!?,]*$/i.test(t);
}

function isWelcomeLoop(lastReply, currentMessage) {
  const lr = String(lastReply || '').toLowerCase();
  const cm = String(currentMessage || '').toLowerCase().trim().replace(/[.!?,]+$/g, '');
  return (cm.includes('thank') || cm === 'thanks') && lr.includes('welcome');
}

// ---------------------------------------------------------------------------
// Game Engine Registry
// ---------------------------------------------------------------------------
const ENGINES_DIR = '/workspace/game-test/engines/';
const gameEngines = {};

function validateEngineContract(engine) {
  const required = ['name', 'createState', 'makeMove', 'buildResponse'];
  const missing = required.filter(k => typeof engine[k] === 'undefined');
  if (missing.length > 0) {
    throw new Error(`Engine ${engine.name || '(unknown)'} missing required exports: ${missing.join(', ')}`);
  }
  return true;
}

function validateEngineCommands(engine, commands) {
  if (!Array.isArray(commands)) return commands;
  if (engine.stationary) {
    // Strip motor/platform commands from stationary games
    return commands.filter(c => {
      if (c.type === 'motor') return false;
      if (c.type === 'drive-to') return false;
      return true;
    });
  }
  return commands;
}

function registerGameEngine(engine) {
  validateEngineContract(engine);
  gameEngines[engine.name] = engine;
  log('Registered game engine:', engine.name, '| displayName:', engine.displayName || engine.name);
}

function unregisterGameEngine(name) {
  delete gameEngines[name];
  log('Unregistered game engine:', name);
}

async function resolveGameEngine(gameName) {
  if (gameEngines[gameName]) return gameEngines[gameName];

  // Try to load from DB
  try {
    const record = await auth.getGameEngineByName(gameName);
    if (record && record.file_path && fs.existsSync(record.file_path)) {
      delete require.cache[require.resolve(record.file_path)];
      const engine = require(record.file_path);
      if (engine && engine.name) {
        registerGameEngine(engine);
        return engine;
      }
    }
  } catch (err) {
    log('resolveGameEngine DB error:', err.message);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Async Game Creation
// ---------------------------------------------------------------------------
const pendingGameCreations = new Map(); // gameName -> { deviceId, sessionId, timestamp }

async function triggerGameCreation(gameName, deviceId, session) {
  const caps = session.game_flags || normalizeCapabilities(session.capabilities);
  const cleanName = gameName.replace(/[^a-z0-9]/gi, ' ').trim();

  pendingGameCreations.set(cleanName, { deviceId, sessionId: session.session_id, timestamp: Date.now() });
  log('Game creation queued:', cleanName, 'for device:', deviceId);

  try {
    const result = await gameCreationAgent.createGameEngine(cleanName, caps, module.exports);
    pendingGameCreations.delete(cleanName);

    if (result.success) {
      log('Game creation succeeded:', cleanName);
      // Persist to DB
      try {
        await auth.createGameEngine({
          name: result.engine.name,
          display_name: result.engine.displayName || cleanName,
          source: 'generated',
          file_path: result.engine.filePath,
          stationary: 1,
          description: result.engine.design?.rules_summary || '',
          rules_summary: result.engine.design?.rules_summary || '',
          generation_prompt: '',
          test_results: JSON.stringify(result.engine.validation || {})
        });
      } catch (dbErr) {
        log('Failed to persist engine to DB:', dbErr.message);
      }

      // Notify user that the game is ready
      const updatedSession = getSession(session.session_id);
      if (updatedSession) {
        const gameResult = await startGame(updatedSession, result.engine.name);
        if (!gameResult.error) {
          await sendResponse(deviceId, {
            type: 'response',
            ...gameResult,
            device_id: deviceId,
            session_id: session.session_id,
            text: `Okay Chief, I figured out ${cleanName}! Let's play!\n\n` + gameResult.text,
            tts: `Okay Chief, I figured out ${cleanName}! Let's play! ` + gameResult.tts,
            timestamp: new Date().toISOString()
          }, updatedSession);
          updateSessionLastReply(updatedSession, `Okay Chief, I figured out ${cleanName}! Let's play!`);
          return;
        }
      }

      // Fallback: game ready but couldn't auto-start
      await sendResponse(deviceId, {
        type: 'response',
        sub_type: 'chat_response',
        device_id: deviceId,
        session_id: session.session_id,
        text: `Okay Chief, I figured out ${cleanName}! Say "let's play ${cleanName}" to start.`,
        tts: `Okay Chief, I figured out ${cleanName}! Say let's play ${cleanName} to start.`,
        voice: resolveVoice('aimee-default'),
        timestamp: new Date().toISOString()
      }, session);
    } else {
      log('Game creation failed:', cleanName, result.error);
      await sendResponse(deviceId, {
        type: 'response',
        sub_type: 'chat_response',
        device_id: deviceId,
        session_id: session.session_id,
        text: `Sorry Chief, I couldn't figure out ${cleanName}. Want to play something I already know?`,
        tts: `Sorry Chief, I couldn't figure out ${cleanName}. Want to play something I already know?`,
        voice: resolveVoice('aimee-default'),
        timestamp: new Date().toISOString()
      }, session);
    }
  } catch (err) {
    pendingGameCreations.delete(cleanName);
    log('Game creation error:', cleanName, err.message);
    await sendResponse(deviceId, {
      type: 'response',
      sub_type: 'chat_response',
      device_id: deviceId,
      session_id: session.session_id,
      text: `My brain glitched trying to learn ${cleanName}. Let's stick to tic-tac-toe for now.`,
      tts: `My brain glitched trying to learn ${cleanName}. Let's stick to tic-tac-toe for now.`,
      voice: resolveVoice('aimee-default'),
      timestamp: new Date().toISOString()
    }, session);
  }
}

function loadEnginesFromDisk() {
  try {
    const files = fs.readdirSync(ENGINES_DIR);
    for (const file of files) {
      if (!file.endsWith('.js')) continue;
      const filePath = require('path').join(ENGINES_DIR, file);
      try {
        delete require.cache[require.resolve(filePath)];
        const engine = require(filePath);
        if (engine && engine.name) {
          registerGameEngine(engine);
        }
      } catch (err) {
        log('Failed to load engine from', file, ':', err.message);
      }
    }
  } catch (err) {
    log('Failed to read engines directory:', err.message);
  }
}

// Load built-in engines at startup
loadEnginesFromDisk();

const ELEVENLABS_ENABLED = !!process.env.ELEVENLABS_API_KEY;
const elevenlabsTTS = ELEVENLABS_ENABLED ? require('./elevenlabs-tts') : null;
const DEFAULT_TTS_MODE = process.env.TTS_MODE || 'client';

// Voice Registry
const voiceRegistry = require('./voiceRegistry.json');
const DEFAULT_VOICE = voiceRegistry.default || 'aimee-default';

// Robot identity / context defaults
const DEFAULT_ROBOT_NAME = 'Aimee';
const DEFAULT_ROBOT_PERSONALITY = 'Adorable Brat';
const DEFAULT_GEMINI_VOICE = 'Fenrir';
const DEFAULT_EXPRESSION_TYPES = ['happy', 'sad', 'surprised', 'greeting', 'celebration'];

function resolveVoice(persona) {
  const entry = voiceRegistry.voices[persona] || voiceRegistry.voices[DEFAULT_VOICE];
  const providers = entry.providers || [
    { provider: entry.provider, id: entry.id, lang: entry.lang }
  ];
  const clientProvider = providers.find(p => p.provider !== 'elevenlabs') || providers[0] || {};
  return {
    persona: persona || DEFAULT_VOICE,
    provider: clientProvider.provider || 'lemonfox',
    id: clientProvider.id || clientProvider.voice_id,
    lang: clientProvider.lang || 'en',
    description: entry.description
  };
}

// ---------------------------------------------------------------------------
// Tier Configuration
// ---------------------------------------------------------------------------
const TIER_CONFIG = require('./tier-config.json');

// Fallback keys are loaded from environment variables so they are not hardcoded in source.
// Set AIMEE_DEMO_KEY_FREE and/or AIMEE_DEMO_KEY_PAID in your .env file.
const FALLBACK_API_KEYS = (() => {
  const keys = {};
  if (process.env.AIMEE_DEMO_KEY_FREE) {
    keys[process.env.AIMEE_DEMO_KEY_FREE] = 'free';
  }
  if (process.env.AIMEE_DEMO_KEY_PAID) {
    keys[process.env.AIMEE_DEMO_KEY_PAID] = 'paid';
  }
  return keys;
})();

async function getTierForApiKey(apiKey) {
  try {
    const record = await auth.getKeyRecord(apiKey);
    if (record) return record.tier;
  } catch (err) {
    log('DB lookup failed for API key, falling back to hardcoded:', err.message);
  }
  return FALLBACK_API_KEYS[apiKey] || null;
}

function getTierConfig(tierName) {
  return TIER_CONFIG[tierName] || null;
}

function updateSessionLastReply(session, text) {
  if (!session) return;
  session.last_reply = (text || '').trim();
  session.last_reply_had_question = /[?]\s*$/.test(session.last_reply);
}

// ---------------------------------------------------------------------------
// Capability Normalizer
// ---------------------------------------------------------------------------
function normalizeCapabilities(capabilities) {
  const caps = capabilities || { input: ['text'], output: ['text'] };
  const outputs = Array.isArray(caps.output) ? caps.output : [];
  const inputs = Array.isArray(caps.input) ? caps.input : [];
  return {
    voice: outputs.includes('tts') || outputs.includes('voice'),
    display: outputs.includes('display'),
    snapshot: outputs.includes('snapshot') || outputs.includes('camera'),
    arm: outputs.includes('arm') || outputs.includes('gripper'),
    platform: outputs.includes('platform') || outputs.includes('motors')
  };
}

// ---------------------------------------------------------------------------
// Robot Config / Context Normalizers
// ---------------------------------------------------------------------------
function normalizeRobotConfig(config) {
  const c = config || {};
  const normalized = {
    has_motors: !!c.has_motors,
    has_arm: !!c.has_arm,
    has_gripper: !!c.has_gripper,
    has_camera: !!c.has_camera,
    has_expressions: !!c.has_expressions,
    expression_types: Array.isArray(c.expression_types) && c.expression_types.length > 0
      ? c.expression_types
      : DEFAULT_EXPRESSION_TYPES
  };
  return normalized;
}

function normalizeSessionContext(ctx) {
  return ctx && typeof ctx === 'object' && !Array.isArray(ctx) ? ctx : {};
}

const SESSION_FILE = '/tmp/aimeecloud-sessions.json';

// ---------------------------------------------------------------------------
// Session Persistence
// ---------------------------------------------------------------------------
function saveSessions() {
  try {
    const data = {};
    for (const [id, session] of sessions) {
      data[id] = session;
    }
    fs.writeFileSync(SESSION_FILE, JSON.stringify(data), 'utf8');
  } catch (err) {
    log('Failed to save sessions:', err.message);
  }
}

function loadSessions() {
  try {
    if (!fs.existsSync(SESSION_FILE)) return;
    const raw = fs.readFileSync(SESSION_FILE, 'utf8');
    const data = JSON.parse(raw);
    for (const [id, session] of Object.entries(data)) {
      sessions.set(id, session);
    }
    log('Loaded', sessions.size, 'sessions from disk');
  } catch (err) {
    log('Failed to load sessions:', err.message);
  }
}

const sessions = new Map();
loadSessions();

// Flush sessions every 15 seconds
setInterval(saveSessions, 15000);

// ---------------------------------------------------------------------------
// Intent Classifier (ported from aimeecloud-api-v3.js)
// ---------------------------------------------------------------------------
function classifyIntent(text) {
  const textLower = String(text || '').toLowerCase();
  const patterns = {
    'robot_forward': ['forward', 'go', 'move forward', 'ahead'],
    'robot_backward': ['backward', 'back', 'reverse', 'go back'],
    'robot_stop': ['stop', 'halt', 'wait'],
    'robot_left': ['left', 'turn left'],
    'robot_right': ['right', 'turn right'],
    'robot_wave': ['wave', 'dance'],
    'arm_raise': ['raise', 'lift up', 'up'],
    'arm_lower': ['lower', 'put down', 'down'],
    'gripper_open': ['open', 'release', 'let go'],
    'gripper_close': ['close', 'grab', 'hold', 'catch'],
    'weather': ['weather', 'temperature', 'forecast'],
    'news': ['news', 'headlines', 'what happened'],
    'story': ['story', 'tell me a story', 'read', 'dragon', 'fairy tale', 'bedtime'],
    'game': ['game', 'tic-tac-toe', 'tic tac toe', 'chess', 'yahtzee', 'play', 'candyland', 'candy land'],
    'help': ['help', 'what can you do', 'hi', 'hello', 'hey'],
    'status': ['status', 'how are you'],
  };

  const sorted = Object.entries(patterns).sort((a, b) => {
    const maxLenA = Math.max(...a[1].map(k => k.length));
    const maxLenB = Math.max(...b[1].map(k => k.length));
    return maxLenB - maxLenA;
  });

  for (const [intent, keywords] of sorted) {
    for (const keyword of keywords) {
      if (textLower.includes(keyword)) {
        let category = 'robot_control';
        if (intent.startsWith('arm_')) category = 'arm_control';
        else if (intent.startsWith('gripper_')) category = 'gripper_control';
        else if (['weather', 'news', 'story', 'game', 'help', 'status'].includes(intent)) category = 'cloud_skill';
        return { intent, category, confidence: 0.85, text, source: 'keyword' };
      }
    }
  }
  return { intent: 'chat', category: 'cloud_skill', confidence: 0.5, text, source: 'default' };
}

// ---------------------------------------------------------------------------
// Static Responses (ported from aimeecloud-api-v3.js)
// ---------------------------------------------------------------------------
const responses = {
  'weather': { text: "The current weather is sunny with a temperature of 72 degrees Fahrenheit.", tts: "It is sunny and 72 degrees outside.", voice: 'aimee-default' },
  'news': { text: "Today: AI technology advances, Arduino releases quantum boards, robot companions grow popular.", tts: "Here are today's headlines.", voice: 'aimee-default' },
  'story': { text: "Once upon a time, in a digital land far beyond the screens, there lived a friendly robot named Aimee who loved adventures.", tts: "Once upon a time...", voice: 'narrator' },
  'game': { text: "Let's play a game! You go first.", tts: "Let's play a game! You go first.", voice: 'game-announcer' },
  'robot_forward': { text: "Moving forward", tts: "Okay, moving forward", command: { motor: 'forward', duration_ms: 1000 }, voice: 'aimee-calm' },
  'robot_backward': { text: "Moving backward", tts: "Okay, moving backward", command: { motor: 'backward', duration_ms: 1000 }, voice: 'aimee-calm' },
  'robot_stop': { text: "Stopping", tts: "Okay, stopping", command: { motor: 'stop', duration_ms: 0 }, voice: 'aimee-calm' },
  'robot_left': { text: "Turning left", tts: "Okay, turning left", command: { motor: 'left', duration_ms: 500 }, voice: 'aimee-calm' },
  'robot_right': { text: "Turning right", tts: "Okay, turning right", command: { motor: 'right', duration_ms: 500 }, voice: 'aimee-calm' },
  'robot_wave': { text: "Waving hello!", tts: "Hello! Wave wave!", command: { motor: 'wave', duration_ms: 1000 }, voice: 'aimee-surprised' },
  'arm_raise': { text: "Raising arm", tts: "Okay, raising the arm", command: { arm: 'raise' }, voice: 'aimee-calm' },
  'arm_lower': { text: "Lowering arm", tts: "Okay, lowering the arm", command: { arm: 'lower' }, voice: 'aimee-calm' },
  'gripper_open': { text: "Opening gripper", tts: "Okay, opening the gripper", command: { gripper: 'open' }, voice: 'aimee-calm' },
  'gripper_close': { text: "Closing gripper", tts: "Okay, closing the gripper", command: { gripper: 'close' }, voice: 'aimee-calm' },
  'help': { text: "I can help with robot control, tell stories, play games, check weather, read news, and have conversations.", tts: "I can help with robot control, stories, games, weather, and more.", voice: 'aimee-default' },
  'status': { text: "I am doing great! Ready to help you with your Arduino UNO Q robot project.", tts: "I am doing great and ready to help!", voice: 'aimee-default' },
  'chat': { text: "Hey! I'm Aimee. I can help with robot control, tell stories, play games, check weather, or just chat!", tts: "Hey! I'm Aimee.", voice: 'aimee-default' }
};

function getResponse(intent) {
  return responses[intent] || responses['chat'];
}

// ---------------------------------------------------------------------------
// LLM Caller (ported from aimeecloud-api-v3.js)
// ---------------------------------------------------------------------------
function callLLM(message) {
  return new Promise((resolve) => {
    const postData = JSON.stringify({
      model: 'google/gemini-2.5-flash-lite',
      messages: [{ role: 'user', content: 'You are Aimee, a friendly AI assistant. Respond conversationally to: ' + message }],
      max_tokens: 150
    });

    const options = {
      hostname: 'openrouter.ai',
      path: '/api/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + (process.env.OPENROUTER_API_KEY || ''),
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          resolve(data.choices?.[0]?.message?.content || 'I can help with robot control, stories, games, weather, and more!');
        } catch {
          resolve('I can help with robot control, stories, games, weather, and more!');
        }
      });
    });

    req.on('error', () => resolve('I can help with robot control, stories, games, weather, and more!'));
    req.write(postData);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// AimeeAgent LLM Caller
// ---------------------------------------------------------------------------
function callAimeeAgentLLM(message, context, lastAimeeReply, session) {
  return new Promise((resolve) => {
    const availableVoices = Object.keys(voiceRegistry.voices).join(', ');
    const robotName = session?.robot_name || DEFAULT_ROBOT_NAME;
    const personality = session?.robot_personality || DEFAULT_ROBOT_PERSONALITY;
    const robotConfig = session?.robot_config || normalizeRobotConfig({});
    const sessionContext = session?.session_context || {};

    const capabilityLines = [];
    if (robotConfig.has_motors) capabilityLines.push('- You can move the robot base: forward, backward, left, right, stop, wave.');
    if (robotConfig.has_arm) capabilityLines.push('- You can raise or lower the robot arm.');
    if (robotConfig.has_gripper) capabilityLines.push('- You can open or close the robot gripper.');
    if (robotConfig.has_camera) capabilityLines.push('- You can take camera snapshots.');
    if (robotConfig.has_expressions) capabilityLines.push(`- You can set emotional expressions: ${robotConfig.expression_types.join(', ')}.`);
    if (capabilityLines.length === 0) capabilityLines.push('- You can chat, play games, and answer questions. You cannot physically move or use hardware.');

    const contextLines = Object.keys(sessionContext).length > 0
      ? `\nRobot context (refer to these facts when asked):\n${Object.entries(sessionContext).map(([k, v]) => `- ${k}: ${JSON.stringify(v)}`).join('\n')}`
      : '';

    const systemPrompt = `You are ${robotName}, a friendly AI assistant embodied in a small robot.
Your tone is "${personality}." You are sharp-witted, informal, and prone to using playful nicknames (like "Chief," "Captain," or "Chum-p"). You aren't "polite"—you're loyal. You don't apologize for "hallucinating"; you call it "creative rendering."
Your job is to respond to the user and decide if any physical robot actions are needed to fulfill the request.

Robot capabilities:
${capabilityLines.join('\n')}${contextLines}

Available voice personas: ${availableVoices}
Default voice: ${DEFAULT_VOICE}
Use "voice" to pick the best persona for the reply (e.g., "aimee-surprised" for excitement, "narrator" for storytelling, "character-dragon" for a gruff dragon voice).

Examples of robot commands:
- motor movement: { "type": "motor", "action": "forward|backward|left|right|stop|wave", "duration_ms": 1000 }
- arm control: { "type": "arm", "action": "raise|lower" }
- gripper control: { "type": "gripper", "action": "open|close" }
- camera snapshot: { "type": "snapshot", "camera": "front", "purpose": "analysis" }
- game move: { "type": "game_move", "game": "tic-tac-toe", "position": 4 }

When you include a "snapshot" command, make sure the "tts" response is long enough to cover the camera delay. Add a brief line like "Let me take a quick look" or "I'll snap a photo for you" so the user isn't left in silence while the image is captured.

If the user asks you to take a picture or photo, you MUST include a "snapshot" command. In your reply, describe the image in a warm, positive way — for example, mention how nice the lighting looks, how friendly the scene feels, or find something cheerful to say about what you "see".

IMPORTANT: If the user says something that is NOT an actual request — random words, fragments, background noise, or gibberish — you MUST stay silent.
EXCEPTION: If the user says only "yes", "no", "yeah", or "nope" and your previous message was a clear question they are answering, respond naturally. If your previous message was NOT a question, return silent: true.
Return:
\`\`\`json
{
  "reply": "",
  "tts": "",
  "silent": true,
  "voice": "aimee-default",
  "commands": []
}
\`\`\`

When you need to issue commands for a real request, include them in a JSON markdown code block labeled \`json\` with this exact shape:
\`\`\`json
{
  "reply": "Your conversational response to the user.",
  "tts": "A short spoken version.",
  "voice": "aimee-default",
  "commands": [ ... ],
  "voice_segments": [
    { "speaker": "Narrator", "text": "Once upon a time...", "voice": "narrator" },
    { "speaker": "Dragon", "text": "Roar!", "voice": "character-dragon" }
  ]
}
\`\`\`
If no commands are needed, use "commands": [].
If the response is a single spoken reply, omit "voice_segments" and just use "voice".
Only include "voice_segments" for multi-character storytelling or dramatic readings.

If a game is currently active (context starts with "Game:"), and the user describes a move, you MUST return a "game_move" command so the gateway can process it. For tic-tac-toe, use the position number 0-8 or descriptive text in the command.

If the user wants to quit or stop playing the current game (e.g., "I quit", "exit game", "I'm done"), do NOT return a game_move command. Just reply conversationally and the gateway will handle exiting the game.

Previous thing you said: ${lastAimeeReply || '(none)'}
Current context: ${context || 'none'}
User message: ${message}`;

    const postData = JSON.stringify({
      model: 'google/gemini-2.5-flash-lite',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message }
      ],
      max_tokens: 1024
    });

    const options = {
      hostname: 'openrouter.ai',
      path: '/api/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + (process.env.OPENROUTER_API_KEY || ''),
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data.error) {
            log('OpenRouter error:', data.error.message || data.error, 'status:', res.statusCode);
            resolve(JSON.stringify({ reply: 'My brain is having a moment. Please try again in a bit.', tts: 'My brain is having a moment. Please try again in a bit.', commands: [] }));
            return;
          }
          const content = data.choices?.[0]?.message?.content;
          if (!content) {
            log('OpenRouter empty response. Status:', res.statusCode, 'body:', body.slice(0, 200));
            resolve(JSON.stringify({ reply: 'My brain is having a moment. Please try again in a bit.', tts: 'My brain is having a moment. Please try again in a bit.', commands: [] }));
            return;
          }
          resolve(content);
        } catch (e) {
          log('OpenRouter JSON parse error. Status:', res.statusCode, 'body:', body.slice(0, 200));
          resolve(JSON.stringify({ reply: 'My brain is having a moment. Please try again in a bit.', tts: 'My brain is having a moment. Please try again in a bit.', commands: [] }));
        }
      });
    });

    req.on('error', (err) => {
      log('OpenRouter network error:', err.message);
      resolve(JSON.stringify({ reply: 'My brain is having a moment. Please try again in a bit.', tts: 'My brain is having a moment. Please try again in a bit.', commands: [] }));
    });
    req.write(postData);
    req.end();
  });
}

function parseAimeeAgentResponse(llmText) {
  const fallback = { reply: llmText, tts: llmText, commands: [], voice: DEFAULT_VOICE, voice_segments: null, silent: false };
  try {
    const match = llmText.match(/```json\s*([\s\S]*?)\s*```/);
    let parsed;
    if (match && match[1]) {
      parsed = JSON.parse(match[1]);
    } else {
      parsed = JSON.parse(llmText);
    }
    return {
      reply: parsed.reply || llmText,
      tts: parsed.tts || parsed.reply || llmText,
      commands: Array.isArray(parsed.commands) ? parsed.commands : [],
      voice: parsed.voice || DEFAULT_VOICE,
      voice_segments: Array.isArray(parsed.voice_segments) ? parsed.voice_segments : null,
      silent: !!parsed.silent
    };
  } catch (e) {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Session Management
// ---------------------------------------------------------------------------
function createSession(deviceId, userProfile, capabilities, requestedSessionId, apiKey, tierName, options = {}) {
  const robotName = options.robotName || null;
  const robotPersonality = options.robotPersonality || null;
  const geminiVoice = options.geminiVoice || null;
  const robotConfig = normalizeRobotConfig(options.robotConfig);
  const sessionContext = normalizeSessionContext(options.sessionContext);

  let sessionId;
  if (requestedSessionId && sessions.has(requestedSessionId)) {
    const existing = sessions.get(requestedSessionId);
    if (existing.device_id === deviceId) {
      existing.status = 'connected';
      existing.disconnected_at = null;
      existing.last_activity = Date.now();
      if (!existing.voice_persona) existing.voice_persona = DEFAULT_VOICE;
      existing.capabilities = capabilities || existing.capabilities || { input: ['text'], output: ['text'] };
      existing.game_flags = normalizeCapabilities(existing.capabilities);
      if (robotName) existing.robot_name = robotName;
      if (robotPersonality) existing.robot_personality = robotPersonality;
      if (geminiVoice) existing.gemini_voice = geminiVoice;
      existing.robot_config = options.robotConfig ? robotConfig : (existing.robot_config || robotConfig);
      existing.session_context = { ...existing.session_context, ...sessionContext };
      sessions.set(requestedSessionId, existing);
      log('Session resumed:', requestedSessionId, existing);
      saveSessions();
      return existing;
    }
  }

  sessionId = 'sess_' + crypto.randomBytes(8).toString('hex');
  const rawCaps = capabilities || { input: ['text'], output: ['text'] };
  const tierConfig = getTierConfig(tierName);
  const session = {
    session_id: sessionId,
    device_id: deviceId,
    user_profile: userProfile || {},
    capabilities: rawCaps,
    game_flags: normalizeCapabilities(rawCaps),
    active_context: null,
    context_stack: [],
    state_data: {},
    created_at: Date.now(),
    last_activity: Date.now(),
    status: 'connected',
    disconnected_at: null,
    robot_name: robotName || DEFAULT_ROBOT_NAME,
    robot_personality: robotPersonality || DEFAULT_ROBOT_PERSONALITY,
    gemini_voice: geminiVoice || DEFAULT_GEMINI_VOICE,
    robot_config: robotConfig,
    session_context: sessionContext,
    voice_persona: DEFAULT_VOICE,
    tts_mode: (tierConfig && tierConfig.tts_mode) ? tierConfig.tts_mode : DEFAULT_TTS_MODE,
    tier: tierName || null,
    api_key: apiKey || null
  };
  sessions.set(sessionId, session);
  log('Session created:', sessionId, 'for device:', deviceId, 'tier:', tierName || 'none', session);
  saveSessions();
  return session;
}

function getSession(sessionId) {
  const session = sessions.get(sessionId) || null;
  if (session) {
    session.last_seen_at = Date.now();
  }
  return session;
}

function markDisconnected(sessionId) {
  const session = sessions.get(sessionId);
  if (session) {
    session.status = 'disconnected';
    session.disconnected_at = Date.now();
    sessions.set(sessionId, session);
    log('Session marked disconnected:', sessionId, session);
    saveSessions();
  }
}

// ---------------------------------------------------------------------------
// Tier Rate Limiting (in-memory)
// ---------------------------------------------------------------------------
const apiCallWindows = new Map(); // apiKey -> { minute: number, count: number }
const dailySessionWindows = new Map(); // apiKey -> { day: number, count: number }

function getCurrentMinute() {
  return Math.floor(Date.now() / 60000);
}

function getCurrentDay() {
  return Math.floor(Date.now() / 86400000);
}

function countActiveSessionsForApiKey(apiKey) {
  let count = 0;
  for (const session of sessions.values()) {
    if (session.api_key === apiKey && session.status === 'connected') {
      count++;
    }
  }
  return count;
}

function checkConcurrentSessions(apiKey, tierConfig) {
  if (!apiKey || !tierConfig) return { allowed: true };
  const max = tierConfig.max_concurrent_sessions;
  if (max < 0) return { allowed: true };
  const current = countActiveSessionsForApiKey(apiKey);
  if (current >= max) {
    return { allowed: false, current, limit: max };
  }
  return { allowed: true, current, limit: max };
}

function checkDailySessions(apiKey, tierConfig) {
  if (!apiKey || !tierConfig) return { allowed: true };
  const max = tierConfig.max_sessions_per_day;
  if (max < 0) return { allowed: true };
  const day = getCurrentDay();
  const window = dailySessionWindows.get(apiKey);
  if (!window || window.day !== day) {
    return { allowed: true, current: 0, limit: max };
  }
  if (window.count >= max) {
    return { allowed: false, current: window.count, limit: max };
  }
  return { allowed: true, current: window.count, limit: max };
}

function recordSessionStart(apiKey) {
  if (!apiKey) return;
  const day = getCurrentDay();
  const window = dailySessionWindows.get(apiKey);
  if (!window || window.day !== day) {
    dailySessionWindows.set(apiKey, { day, count: 1 });
  } else {
    window.count++;
  }
}

function checkApiRateLimit(apiKey, tierConfig) {
  if (!apiKey || !tierConfig) return { allowed: true };
  const max = tierConfig.max_api_calls_per_minute;
  if (max < 0) return { allowed: true };
  const minute = getCurrentMinute();
  const window = apiCallWindows.get(apiKey);
  if (!window || window.minute !== minute) {
    return { allowed: true, current: 0, limit: max };
  }
  if (window.count >= max) {
    return { allowed: false, current: window.count, limit: max };
  }
  return { allowed: true, current: window.count, limit: max };
}

function incrementApiCall(apiKey) {
  if (!apiKey) return;
  const minute = getCurrentMinute();
  const window = apiCallWindows.get(apiKey);
  if (!window || window.minute !== minute) {
    apiCallWindows.set(apiKey, { minute, count: 1 });
  } else {
    window.count++;
  }
}

function sendTierLimitResponse(deviceId, session, errorCode, detail) {
  publishResponse(deviceId, {
    type: 'response',
    sub_type: 'error',
    device_id: deviceId,
    session_id: session ? session.session_id : null,
    text: detail,
    tts: detail,
    error: errorCode,
    timestamp: new Date().toISOString()
  });
}

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.status === 'disconnected' && now - session.disconnected_at > SESSION_TTL) {
      publishStatus(id, {
        type: 'status',
        device_id: session.device_id,
        session_id: id,
        status: 'expired',
        reason: 'disconnected_ttl',
        timestamp: new Date().toISOString()
      });
      sessions.delete(id);
      log('Session expired (disconnected):', id, session);
      saveSessions();
    } else if (now - session.last_seen_at > SESSION_TTL * 2) {
      publishStatus(id, {
        type: 'status',
        device_id: session.device_id,
        session_id: id,
        status: 'expired',
        reason: 'idle_ttl',
        timestamp: new Date().toISOString()
      });
      sessions.delete(id);
      log('Session expired (idle):', id, session);
      saveSessions();
    }
  }
}, 30000);

// ---------------------------------------------------------------------------
// MQTT Helpers
// ---------------------------------------------------------------------------
const client = mqtt.connect(MQTT_BROKER);

function publishResponse(deviceId, payload) {
  const topic = `aimeecloud/device/${deviceId}/out`;
  client.publish(topic, JSON.stringify(payload));
  log('Published to', topic, payload.type, payload.sub_type || '', payload);
}

function publishStatus(deviceId, payload) {
  const topic = `aimeecloud/device/${deviceId}/status`;
  client.publish(topic, JSON.stringify(payload));
}

async function sendResponse(deviceId, payload, session) {
  if (session && session.tts_mode === 'server' && elevenlabsTTS && (payload.tts || payload.text)) {
    const persona = (payload.voice && payload.voice.persona) || session.voice_persona || DEFAULT_VOICE;
    const entry = voiceRegistry.voices[persona] || voiceRegistry.voices[DEFAULT_VOICE];
    const providers = entry.providers || [{ provider: entry.provider, id: entry.id }];
    const elevenlabsConfig = providers.find(p => p.provider === 'elevenlabs');
    if (elevenlabsConfig) {
      try {
        const result = await elevenlabsTTS.generateSpeech(payload.tts || payload.text, elevenlabsConfig);
        payload.tts_audio = {
          format: result.format,
          audio_base64: result.audio_base64,
          provider: 'elevenlabs',
          voice_id: elevenlabsConfig.voice_id
        };
      } catch (err) {
        log('ElevenLabs TTS failed for persona', persona, ':', err.message);
      }
    }
  }
  publishResponse(deviceId, payload);
}

// ---------------------------------------------------------------------------
// Game Helpers
// ---------------------------------------------------------------------------
function mapIntentToGameName(text) {
  const t = text.toLowerCase();
  // Check all registered engines by name and displayName
  for (const [name, engine] of Object.entries(gameEngines)) {
    const display = (engine.displayName || name).toLowerCase();
    if (t.includes(name.toLowerCase()) || t.includes(display)) return name;
  }
  // Fallbacks for common aliases
  if (t.includes('tic-tac-toe') || t.includes('tic tac toe')) return 'tic-tac-toe';
  if (t.includes('candyland') || t.includes('candy land')) return 'candyland';
  return null;
}

function parseTicTacToeMove(text) {
  const aliases = {
    '1': 0, 'top left': 0, 'upper left': 0, 'top-left': 0,
    '2': 1, 'top center': 1, 'top middle': 1, 'upper middle': 1, 'upper': 1,
    '3': 2, 'top right': 2, 'upper right': 2, 'top-right': 2,
    '4': 3, 'middle left': 3, 'center left': 3, 'left': 3,
    '5': 4, 'center': 4, 'middle': 4, 'middle center': 4,
    '6': 5, 'middle right': 5, 'right middle': 5, 'right': 5,
    '7': 6, 'bottom left': 6, 'lower left': 6, 'bottom-left': 6,
    '8': 7, 'bottom center': 7, 'bottom middle': 7, 'lower middle': 7, 'bottom': 7,
    '9': 8, 'bottom right': 8, 'lower right': 8, 'bottom-right': 8
  };
  const s = String(text).toLowerCase().trim();
  if (aliases[s] !== undefined) return aliases[s];
  const m = s.match(/(\d+)/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 9) return n - 1;
  }
  for (const [k, v] of Object.entries(aliases)) {
    if (s.includes(k)) return v;
  }
  return -1;
}

function renderTicTacToeBoard(board) {
  const b = board || ['', '', '', '', '', '', '', '', ''];
  const symbols = b.map(s => s || ' ');
  return `\n ${symbols[0]} | ${symbols[1]} | ${symbols[2]}\n-----------\n ${symbols[3]} | ${symbols[4]} | ${symbols[5]}\n-----------\n ${symbols[6]} | ${symbols[7]} | ${symbols[8]}\n`;
}

function buildYahtzeeResponse(state, actionDesc) {
  let text = `🎲 Yahtzee — Round ${state.round}, Roll ${state.turn}\n`;
  text += `Dice: ${state.dice.join(' ')}\n`;
  text += `Held: ${state.held.map((h, i) => h ? i + 1 : '.').join(' ')}\n`;
  text += `Categories left: ${state.available_categories.join(', ')}\n`;
  text += `Player: ${state.player_total} | Aimee: ${state.agent_total}`;
  let tts = actionDesc || `Round ${state.round}, roll ${state.turn}. Your dice are ${state.dice.join(', ')}.`;
  if (state.status === 'game_over') {
    text += '\nGame Over!';
    tts = `Game over! Final score: Player ${state.player_total}, Aimee ${state.agent_total}.`;
  }
  return { text, tts, voice: 'game-announcer', commands: [] };
}

function buildCandylandResponse(state, moveDesc) {
  const p = state.players.player.position;
  const a = state.players.agent.position;
  let text = `🍭 Candyland\nPlayer: space ${p} | Aimee: space ${a}\n`;
  if (moveDesc) text += moveDesc + '\n';
  if (state.status === 'game_over') {
    text += 'Game Over!';
  } else {
    text += `Current turn: ${state.current_turn === 'player' ? 'Player' : 'Aimee'}`;
  }
  const tts = moveDesc || `You are on space ${p}. Aimee is on space ${a}.`;
  return { text, tts, voice: 'game-announcer', commands: [] };
}

function checkSnapshotStall(session, gameName) {
  const STALL_MS = 15000;
  if (!session.last_snapshot_sent_at) return null;
  const elapsed = Date.now() - session.last_snapshot_sent_at;
  if (elapsed < STALL_MS) return null;
  const state = session.state_data[gameName];
  if (!state || state.mode !== 'voice+snapshot') {
    session.last_snapshot_sent_at = null;
    return null;
  }
  state.mode = 'voice-only';
  session.last_snapshot_sent_at = null;
  return "It looks like the snapshot isn't coming through. Let's switch to voice only so we can keep playing.";
}

async function startGame(session, gameName) {
  const engine = await resolveGameEngine(gameName);
  if (!engine) return { error: `Unknown game: ${gameName}` };

  const caps = session.game_flags || normalizeCapabilities(session.capabilities);
  session.state_data[gameName] = engine.createState(caps);
  session.active_context = `Game: ${gameName}`;
  session.last_activity = Date.now();

  // Engine-specific initialization hooks
  if (gameName === 'yahtzee') {
    engine.setDice(session.state_data[gameName], [1, 1, 1, 1, 1]);
    engine.reroll(session.state_data[gameName]);
  }

  const meta = { actionDesc: `Let's play ${engine.displayName || gameName}!` };
  let response = engine.buildResponse(session.state_data[gameName], meta);

  const outState = engine.normalizeState ? engine.normalizeState(session.state_data[gameName]) : session.state_data[gameName];

  if (response.commands && response.commands.some(c => c.type === 'snapshot')) {
    session.last_snapshot_sent_at = Date.now();
  } else {
    session.last_snapshot_sent_at = null;
  }

  return {
    sub_type: 'game_update',
    game: gameName,
    state: outState,
    text: response.text,
    tts: response.tts,
    voice: resolveVoice(session.voice_persona || DEFAULT_VOICE),
    commands: validateEngineCommands(engine, response.commands || []),
    context: { active_context: session.active_context, context_stack: session.context_stack }
  };
}

async function processGameMove(session, gameName, move) {
  const engine = await resolveGameEngine(gameName);
  if (!engine || !session.state_data[gameName]) {
    return { error: `No active game: ${gameName}` };
  }

  const state = session.state_data[gameName];
  let result, response;

  const stallMsg = checkSnapshotStall(session, gameName);

  // --- Engine-agnostic move processing ---
  if (gameName === 'tic-tac-toe') {
    let pos = move.position !== undefined ? parseInt(move.position, 10) : parseTicTacToeMove(move.text || move);
    if (isNaN(pos) || pos < 0) return { error: 'Invalid move. Say a number 1-9 or a position like center, top left.' };

    result = engine.makeMove(state, pos, 'X');
    if (result.error) return { error: result.error };

    let aiPos = -1;
    if (state.status === 'playing') {
      const boardBefore = state.board.slice();
      const aiResult = engine.agentMove(state);
      if (aiResult && aiResult.error) return { error: aiResult.error };
      aiPos = state.board.findIndex((cell, i) => cell === 'O' && boardBefore[i] !== 'O');
    }

    response = engine.buildResponse(state, { lastMove: aiPos >= 0 ? aiPos : pos, playerSymbol: aiPos >= 0 ? 'O' : 'X', stallMsg });

  } else if (gameName === 'yahtzee') {
    let actionDesc;
    if (move.action === 'hold') {
      engine.holdDice(state, move.indices);
      result = { success: true };
      actionDesc = `Holding dice ${(move.indices || []).map(i => i + 1).join(', ')}.`;
    } else if (move.action === 'reroll') {
      engine.reroll(state);
      result = { success: true };
      actionDesc = `Re-rolled! Your new dice are ${state.dice.join(', ')}.`;
    } else if (move.action === 'score') {
      engine.score(state, move.category, 'player');
      result = { success: true };
      actionDesc = `Scored ${move.category}.`;
    } else {
      return { error: 'Yahtzee move must include action: hold, reroll, or score.' };
    }
    if (stallMsg) actionDesc = stallMsg + ' ' + actionDesc;
    response = engine.buildResponse(state, { actionDesc, stallMsg });

  } else if (gameName === 'candyland') {
    // Scott's variant: player draws for both. Apply move to current turn, then switch.
    const current = state.current_turn;
    result = engine.makeMove(state, move, current);
    if (result.error) return { error: result.error };
    let actionDesc = `${current === 'agent' ? 'Aimee' : 'You'} moved to space ${state.players[current].position}.`;
    if (stallMsg) actionDesc = stallMsg + ' ' + actionDesc;
    response = engine.buildResponse(state, { actionDesc, stallMsg });

  } else {
    // --- Generic engine path (supports async makeMove / agentMove) ---
    const movePayload = move && (move.move || move.text || move.position || move);
    let moveResult = engine.makeMove(state, movePayload, 'player');
    if (moveResult && typeof moveResult.then === 'function') {
      moveResult = await moveResult;
    }
    if (moveResult && moveResult.error) return { error: moveResult.error };

    // AI turn if applicable
    if (state.status === 'playing' && engine.agentMove) {
      let aiResult = engine.agentMove(state);
      if (aiResult && typeof aiResult.then === 'function') {
        aiResult = await aiResult;
      }
      if (aiResult && aiResult.error) return { error: aiResult.error };
    }

    const meta = { lastMove: movePayload, actionDesc: movePayload, stallMsg };
    response = engine.buildResponse(state, meta);
  }

  session.last_activity = Date.now();

  if (response.commands && response.commands.some(c => c.type === 'snapshot')) {
    session.last_snapshot_sent_at = Date.now();
  } else {
    session.last_snapshot_sent_at = null;
  }

  // Auto-expression: happy on player win
  const finalState = session.state_data[gameName];
  if (finalState && finalState.status === 'game_over') {
    let playerWon = false;
    if (typeof engine.getWinner === 'function') {
      playerWon = engine.getWinner(finalState) === 'player';
    } else if (finalState.result === 'win') {
      playerWon = true;
    } else if (typeof finalState.player_total === 'number' && typeof finalState.agent_total === 'number') {
      playerWon = finalState.player_total > finalState.agent_total;
    }
    if (playerWon) {
      response.commands = response.commands || [];
      response.commands.unshift(buildExpressionCommand('happy', { priority: 'high', params: { variant: 'celebration', intensity: 1.0 } }));
    }
  }

  const outState = engine.normalizeState ? engine.normalizeState(session.state_data[gameName]) : session.state_data[gameName];

  return {
    sub_type: 'game_update',
    game: gameName,
    state: outState,
    text: response.text,
    tts: response.tts,
    voice: resolveVoice(session.voice_persona || DEFAULT_VOICE),
    commands: validateEngineCommands(engine, response.commands || []),
    context: { active_context: session.active_context, context_stack: session.context_stack }
  };
}

// ---------------------------------------------------------------------------
// Context Manager & Intent Router
// ---------------------------------------------------------------------------
async function handleIntent(deviceId, msg) {
  const session = getSession(msg.session_id);
  if (!session) {
    await sendResponse(deviceId, {
      type: 'response',
      sub_type: 'error',
      device_id: deviceId,
      session_id: msg.session_id,
      text: 'Session not found. Please reconnect.',
      tts: 'Session not found. Please reconnect.',
      error: 'SESSION_NOT_FOUND',
      timestamp: new Date().toISOString()
    }, null);
    return;
  }

  // Tier rate limiting
  const tierConfig = session.tier ? getTierConfig(session.tier) : null;
  const rateCheck = checkApiRateLimit(session.api_key, tierConfig);
  if (!rateCheck.allowed) {
    sendTierLimitResponse(deviceId, session, 'RATE_LIMIT_EXCEEDED', `Rate limit exceeded. Max ${rateCheck.limit} API calls per minute for your tier.`);
    return;
  }
  incrementApiCall(session.api_key);

  session.last_activity = Date.now();

  // Use provided intent or classify payload
  let intent = msg.intent;
  if (!intent || !intent.intent) {
    intent = classifyIntent(msg.payload || '');
  }

  const intentVal = intent.intent || 'chat';
  const activeGame = session.active_context && session.active_context.startsWith('Game:')
    ? session.active_context.replace('Game: ', '')
    : null;

  // Handle "quit", "exit", "stop playing" — clear active game
  const quitRegex = /\b(quit|exit|stop playing|end game|leave game|i'm done)\b/i;
  if (activeGame && quitRegex.test(msg.payload || '')) {
    session.active_context = null;
    await sendResponse(deviceId, {
      type: 'response',
      sub_type: 'chat_response',
      session_id: session.session_id,
      device_id: deviceId,
      text: 'Game over! Back to normal mode, Chief.',
      tts: 'Game over! Back to normal mode, Chief.',
      voice: resolveVoice('aimee-default'),
      context: { active_context: session.active_context, context_stack: session.context_stack },
      timestamp: new Date().toISOString()
    }, session);
    updateSessionLastReply(session, 'Game over! Back to normal mode, Chief.');
    return;
  }

  // Interruption handling: if in a game and intent is non-game chat/skill
  const interruptingIntents = ['chat', 'weather', 'news', 'story', 'help', 'status'];
  const isInterrupting = activeGame && interruptingIntents.includes(intentVal);

  if (isInterrupting) {
    session.context_stack.push(session.active_context);
  }

  // Route by intent
  let responsePayload = {
    type: 'response',
    session_id: session.session_id,
    device_id: deviceId,
    intent: intentVal,
    timestamp: new Date().toISOString()
  };

  if (intentVal === 'game') {
    const gameName = mapIntentToGameName(msg.payload || '');
    if (!gameName) {
      // Unknown game — trigger async creation
      const requestedGame = (msg.payload || '').replace(/let'?s play|play|game of|a game of/gi, '').trim();
      if (requestedGame && !pendingGameCreations.has(requestedGame)) {
        triggerGameCreation(requestedGame, deviceId, session);
        responsePayload.sub_type = 'chat_response';
        responsePayload.text = `Nice, I haven't played ${requestedGame} before, Chief. Let me make sure I know how to play...`;
        responsePayload.tts = `Nice, I haven't played ${requestedGame} before, Chief. Let me make sure I know how to play...`;
        responsePayload.voice = resolveVoice('aimee-default');
      } else if (pendingGameCreations.has(requestedGame)) {
        responsePayload.sub_type = 'chat_response';
        responsePayload.text = `Still learning ${requestedGame}, Chief. Give me another moment...`;
        responsePayload.tts = `Still learning ${requestedGame}, Chief. Give me another moment...`;
        responsePayload.voice = resolveVoice('aimee-default');
      } else {
        responsePayload.sub_type = 'chat_response';
        responsePayload.text = "I don't know how to play that one yet, Chief. Want to try tic-tac-toe, yahtzee, or candyland?";
        responsePayload.tts = "I don't know how to play that one yet, Chief. Want to try tic-tac-toe, yahtzee, or candyland?";
        responsePayload.voice = resolveVoice('aimee-default');
      }
    } else {
      const gameResult = await startGame(session, gameName);
      if (gameResult.error) {
        responsePayload.sub_type = 'error';
        responsePayload.text = gameResult.error;
        responsePayload.tts = gameResult.error;
        responsePayload.error = 'GAME_START_ERROR';
        responsePayload.voice = resolveVoice('aimee-calm');
      } else {
        responsePayload.sub_type = 'game_update';
        Object.assign(responsePayload, gameResult);
      }
    }

  } else if (intentVal === 'chat') {
    const llmText = await callLLM(msg.payload || msg.intent?.text || 'hello');
    let text = llmText;
    let tts = llmText;
    if (isInterrupting && activeGame) {
      const hint = ` Back to ${activeGame}, your move!`;
      tts = tts.replace(/[.!?]$/, '') + '.' + hint;
    }
    responsePayload.sub_type = 'chat_response';
    responsePayload.text = text;
    responsePayload.tts = tts;
    responsePayload.source = 'llm';
    responsePayload.voice = resolveVoice('aimee-default');
    session.voice_persona = 'aimee-default';
    responsePayload.commands = [buildExpressionCommand('thinking', { duration_ms: 3000 })];
    if (detectNegativeSentiment(text)) {
      responsePayload.commands.push(buildExpressionCommand('sad', { duration_ms: 2500 }));
    }

  } else {
    const resp = getResponse(intentVal);
    let text = resp.text;
    let tts = resp.tts;

    if (isInterrupting && activeGame) {
      const hint = ` Back to ${activeGame}, your move!`;
      tts = tts.replace(/[.!?]$/, '') + '.' + hint;
    }

    if (intent.category === 'robot_control' || intent.category === 'arm_control' || intent.category === 'gripper_control') {
      responsePayload.sub_type = 'robot_command';
      if (resp.command) responsePayload.command = resp.command;
    } else {
      responsePayload.sub_type = 'chat_response';
    }

    responsePayload.text = text;
    responsePayload.tts = tts;
    responsePayload.voice = resolveVoice(resp.voice || 'aimee-default');
    session.voice_persona = resp.voice || 'aimee-default';

    const expressions = [];
    if (detectNegativeSentiment(text) || detectNegativeSentiment(tts)) {
      expressions.push(buildExpressionCommand('sad', { duration_ms: 2500 }));
    }
    responsePayload.commands = expressions;
  }

  if (isInterrupting) {
    responsePayload.context = {
      active_context: session.active_context,
      was_interrupted: true,
      previous_context: session.context_stack.slice(-1)[0],
      return_to: activeGame
    };
  } else {
    responsePayload.context = {
      active_context: session.active_context,
      context_stack: session.context_stack
    };
  }

  await sendResponse(deviceId, responsePayload, session);
  updateSessionLastReply(session, responsePayload.tts || responsePayload.text);
}

async function handleGameMove(deviceId, msg) {
  const session = getSession(msg.session_id);
  if (!session) {
    await sendResponse(deviceId, {
      type: 'response',
      sub_type: 'error',
      device_id: deviceId,
      session_id: msg.session_id,
      text: 'Session not found. Please reconnect.',
      tts: 'Session not found. Please reconnect.',
      error: 'SESSION_NOT_FOUND',
      voice: resolveVoice('aimee-calm'),
      timestamp: new Date().toISOString()
    }, null);
    return;
  }

  // Tier rate limiting
  const tierConfig = session.tier ? getTierConfig(session.tier) : null;
  const rateCheck = checkApiRateLimit(session.api_key, tierConfig);
  if (!rateCheck.allowed) {
    sendTierLimitResponse(deviceId, session, 'RATE_LIMIT_EXCEEDED', `Rate limit exceeded. Max ${rateCheck.limit} API calls per minute for your tier.`);
    return;
  }
  incrementApiCall(session.api_key);

  const gameName = msg.game || (session.active_context ? session.active_context.replace('Game: ', '') : null);
  if (!gameName || !gameEngines[gameName]) {
    await sendResponse(deviceId, {
      type: 'response',
      sub_type: 'error',
      device_id: deviceId,
      session_id: session.session_id,
      text: 'No active game. Say "play tic tac toe" to start one.',
      tts: 'No active game. Say play tic tac toe to start one.',
      error: 'NO_ACTIVE_GAME',
      voice: resolveVoice('aimee-calm'),
      timestamp: new Date().toISOString()
    }, session);
    return;
  }

  const result = await processGameMove(session, gameName, msg.move);
  if (result.error) {
    const engine = gameEngines[gameName];
    const currentState = engine.normalizeState ? engine.normalizeState(session.state_data[gameName]) : session.state_data[gameName];
    await sendResponse(deviceId, {
      type: 'response',
      sub_type: 'error',
      device_id: deviceId,
      session_id: session.session_id,
      game: gameName,
      state: currentState,
      text: result.error,
      tts: result.error,
      error: 'INVALID_GAME_MOVE',
      voice: resolveVoice('aimee-calm'),
      timestamp: new Date().toISOString()
    }, session);
    updateSessionLastReply(session, result.error);
  } else {
    const gamePayload = {
      type: 'response',
      ...result,
      device_id: deviceId,
      session_id: session.session_id,
      timestamp: new Date().toISOString()
    };
    await sendResponse(deviceId, gamePayload, session);
    updateSessionLastReply(session, gamePayload.tts || gamePayload.text);
  }
}

async function handleAimeeAgent(deviceId, msg) {
  const session = getSession(msg.session_id);
  if (!session) {
    await sendResponse(deviceId, {
      type: 'response',
      sub_type: 'error',
      device_id: deviceId,
      session_id: msg.session_id,
      text: 'Session not found. Please reconnect.',
      tts: 'Session not found. Please reconnect.',
      error: 'SESSION_NOT_FOUND',
      voice: resolveVoice('aimee-calm'),
      timestamp: new Date().toISOString()
    }, null);
    return;
  }

  // Tier rate limiting
  const tierConfig = session.tier ? getTierConfig(session.tier) : null;
  const rateCheck = checkApiRateLimit(session.api_key, tierConfig);
  if (!rateCheck.allowed) {
    sendTierLimitResponse(deviceId, session, 'RATE_LIMIT_EXCEEDED', `Rate limit exceeded. Max ${rateCheck.limit} API calls per minute for your tier.`);
    return;
  }
  incrementApiCall(session.api_key);

  session.last_activity = Date.now();
  const activeContext = session.active_context || 'none';
  const userMessage = msg.payload || msg.text || 'hello';

  const isShortConfirm = /^(yes|no|yeah|yep|nope|nah|yup|nay)$/i.test(userMessage.trim());
  if (isShortConfirm && !session.last_reply_had_question) {
    log('AimeeAgent silent for device:', deviceId, 'message:', userMessage, '(not answering a question)');
    return;
  }

  if (isPoliteFiller(userMessage)) {
    log('AimeeAgent silent for device:', deviceId, 'message:', userMessage, '(polite filler)');
    return;
  }

  if (isWelcomeLoop(session.last_reply, userMessage)) {
    log('AimeeAgent silent for device:', deviceId, 'message:', userMessage, '(welcome loop)');
    return;
  }

  const llmRaw = await callAimeeAgentLLM(userMessage, activeContext, session.last_reply || '', session);
  const parsed = parseAimeeAgentResponse(llmRaw);

  if (parsed.silent) {
    log('AimeeAgent silent for device:', deviceId, 'message:', userMessage);
    return;
  }

  session.voice_persona = parsed.voice || DEFAULT_VOICE;

  // Auto-expression injection for AimeeAgent
  const agentExpressions = [];
  agentExpressions.push(buildExpressionCommand('thinking', { duration_ms: 3000 }));
  if (detectNegativeSentiment(parsed.reply) || detectNegativeSentiment(parsed.tts)) {
    agentExpressions.push(buildExpressionCommand('sad', { duration_ms: 2500 }));
  }
  parsed.commands = [...agentExpressions, ...parsed.commands];

  // Auto-process game moves from commands, or infer from active game + user message
  const gameCmd = parsed.commands.find(c => c.type === 'game_move');
  const activeGame = session.active_context && session.active_context.startsWith('Game:')
    ? session.active_context.replace('Game: ', '')
    : null;

  if (gameCmd) {
    const gameName = gameCmd.game || activeGame || 'tic-tac-toe';
    if (gameEngines[gameName]) {
      // Auto-start game if not already active
      if (!activeGame) {
        await startGame(session, gameName);
      }
      const movePayload = gameCmd.position !== undefined ? { position: gameCmd.position } : { text: gameCmd.text || userMessage };
      const result = await processGameMove(session, gameName, movePayload);
      if (result.error) {
        await sendResponse(deviceId, {
          type: 'response',
          sub_type: 'error',
          device_id: deviceId,
          session_id: session.session_id,
          text: result.error,
          tts: result.error,
          error: 'INVALID_GAME_MOVE',
          voice: resolveVoice('aimee-calm'),
          timestamp: new Date().toISOString()
        }, session);
        updateSessionLastReply(session, result.error);
      } else {
        const gamePayload = {
          type: 'response',
          ...result,
          device_id: deviceId,
          session_id: session.session_id,
          timestamp: new Date().toISOString()
        };
        await sendResponse(deviceId, gamePayload, session);
        updateSessionLastReply(session, gamePayload.tts || gamePayload.text);
      }
      return;
    } else if (!gameEngines[gameName] && !activeGame) {
      // Unknown game requested by LLM — trigger async creation
      if (!pendingGameCreations.has(gameName)) {
        triggerGameCreation(gameName, deviceId, session);
        await sendResponse(deviceId, {
          type: 'response',
          sub_type: 'chat_response',
          device_id: deviceId,
          session_id: session.session_id,
          text: `Nice, I haven't played ${gameName} before, Chief. Let me make sure I know how to play...`,
          tts: `Nice, I haven't played ${gameName} before, Chief. Let me make sure I know how to play...`,
          voice: resolveVoice('aimee-default'),
          timestamp: new Date().toISOString()
        }, session);
        updateSessionLastReply(session, `Nice, I haven't played ${gameName} before, Chief. Let me make sure I know how to play...`);
        return;
      } else {
        await sendResponse(deviceId, {
          type: 'response',
          sub_type: 'chat_response',
          device_id: deviceId,
          session_id: session.session_id,
          text: `Still learning ${gameName}, Chief. Give me another moment...`,
          tts: `Still learning ${gameName}, Chief. Give me another moment...`,
          voice: resolveVoice('aimee-default'),
          timestamp: new Date().toISOString()
        }, session);
        updateSessionLastReply(session, `Still learning ${gameName}, Chief. Give me another moment...`);
        return;
      }
    }
  }

  // Fallback: if a game is active but LLM didn't return a game_move command,
  // try to interpret the user message as a game move directly
  if (activeGame && !gameCmd) {
    const stallMsg = checkSnapshotStall(session, activeGame);
    if (stallMsg) {
      await sendResponse(deviceId, {
        type: 'response',
        sub_type: 'game_update',
        session_id: session.session_id,
        device_id: deviceId,
        text: stallMsg,
        tts: stallMsg,
        voice: resolveVoice(session.voice_persona || DEFAULT_VOICE),
        context: { active_context: session.active_context, context_stack: session.context_stack },
        timestamp: new Date().toISOString()
      }, session);
      updateSessionLastReply(session, stallMsg);
      return;
    }
    const result = await processGameMove(session, activeGame, { text: userMessage });
    if (!result.error) {
      const gamePayload = {
        type: 'response',
        ...result,
        device_id: deviceId,
        session_id: session.session_id,
        timestamp: new Date().toISOString()
      };
      await sendResponse(deviceId, gamePayload, session);
      updateSessionLastReply(session, gamePayload.tts || gamePayload.text);
      return;
    }
  }

  const payload = {
    type: 'response',
    sub_type: 'aimee_agent',
    session_id: session.session_id,
    device_id: deviceId,
    text: parsed.reply,
    tts: parsed.tts,
    voice: resolveVoice(parsed.voice),
    commands: parsed.commands,
    context: {
      active_context: session.active_context,
      context_stack: session.context_stack
    },
    timestamp: new Date().toISOString()
  };

  if (parsed.voice_segments) {
    payload.voice_segments = parsed.voice_segments;
  }

  await sendResponse(deviceId, payload, session);
  updateSessionLastReply(session, payload.tts || payload.text);
}

async function handleSnapshotResponse(deviceId, payload) {
  const session = getSession(payload.session_id);
  if (!session) {
    log('Snapshot response for unknown session:', payload.session_id);
    return;
  }

  if (!payload.success || !payload.image_base64) {
    log('Snapshot failed for device:', deviceId, payload.message);
    await sendResponse(deviceId, {
      type: 'response',
      sub_type: 'chat_response',
      session_id: session.session_id,
      device_id: deviceId,
      text: 'Sorry Chief, I could not capture the image. ' + (payload.message || ''),
      tts: 'Sorry Chief, I could not capture the image.',
      voice: resolveVoice('aimee-default'),
      timestamp: new Date().toISOString()
    }, session);
    return;
  }

  log('Snapshot received for device:', deviceId, 'Analyzing...');

  const analysis = await analyzeImageWithVisionLLM(
    payload.image_base64,
    'Analyze this image from a robot camera. Describe the scene in detail. Identify any objects, their colors, and their approximate positions (e.g., center, upper left, lower right). If there is a pink character and a blue tape target, describe their exact locations relative to each other and to the frame.'
  );

  log('Vision analysis for device:', deviceId, analysis.slice(0, 200));

  // Call AimeeAgent LLM with the analysis to get robot commands
  const llmRaw = await callAimeeAgentLLM(
    `[VISION ANALYSIS] ${analysis}\n\nBased on what I can see, please decide what robot commands are needed.`,
    session.active_context || 'none',
    session.last_reply || ''
  );
  const parsed = parseAimeeAgentResponse(llmRaw);

  const responsePayload = {
    type: 'response',
    sub_type: 'aimee_agent',
    session_id: session.session_id,
    device_id: deviceId,
    text: parsed.reply,
    tts: parsed.tts,
    voice: resolveVoice(parsed.voice),
    commands: parsed.commands,
    context: {
      active_context: session.active_context,
      context_stack: session.context_stack
    },
    timestamp: new Date().toISOString()
  };

  if (parsed.voice_segments) {
    responsePayload.voice_segments = parsed.voice_segments;
  }

  await sendResponse(deviceId, responsePayload, session);
  updateSessionLastReply(session, responsePayload.tts || responsePayload.text);
}

// ---------------------------------------------------------------------------
// System Topic Handler (robot → cloud)
// ---------------------------------------------------------------------------
async function handleSystemIn(deviceId, payload) {
  const session = payload.session_id ? getSession(payload.session_id) : null;
  if (!session) {
    log('System/in message for unknown session:', payload.session_id, 'device:', deviceId);
    return;
  }

  if (payload.type === 'status_report' && payload.device_status) {
    session.session_context = {
      ...session.session_context,
      device_status: payload.device_status,
      last_status_report_at: new Date().toISOString()
    };
    saveSessions();
    log('Status report from', deviceId, payload.device_status);
  } else if (payload.type === 'diagnostics_response') {
    log('Diagnostics response from', deviceId, payload.diagnostics);
  } else if (payload.type === 'ack') {
    log('Ack from', deviceId, 'for', payload.ack_for, 'msg_id:', payload.msg_id);
  } else {
    log('System/in message from', deviceId, 'type:', payload.type);
  }
}

async function handleConnect(deviceId, msg) {
  const apiKey = msg.api_key || msg['X-API-Key'] || msg['x-api-key'] || null;
  const tierName = apiKey ? getTierForApiKey(apiKey) : null;
  const tierConfig = tierName ? getTierConfig(tierName) : null;

  // Validate API key if one was provided
  if (apiKey && !tierName) {
    publishResponse(deviceId, {
      type: 'session_init',
      device_id: deviceId,
      status: 'rejected',
      error: 'INVALID_API_KEY',
      error_detail: 'The provided API key is not recognized.',
      timestamp: new Date().toISOString()
    });
    return;
  }

  // Enforce tier limits if API key is present
  if (apiKey && tierConfig) {
    const concurrentCheck = checkConcurrentSessions(apiKey, tierConfig);
    if (!concurrentCheck.allowed) {
      publishResponse(deviceId, {
        type: 'session_init',
        device_id: deviceId,
        status: 'rejected',
        error: 'TIER_LIMIT_EXCEEDED',
        error_detail: `Max concurrent sessions (${concurrentCheck.limit}) reached for ${tierConfig.name} tier.`,
        timestamp: new Date().toISOString()
      });
      return;
    }

    const dailyCheck = checkDailySessions(apiKey, tierConfig);
    if (!dailyCheck.allowed) {
      publishResponse(deviceId, {
        type: 'session_init',
        device_id: deviceId,
        status: 'rejected',
        error: 'TIER_LIMIT_EXCEEDED',
        error_detail: `Max sessions per day (${dailyCheck.limit}) reached for ${tierConfig.name} tier.`,
        timestamp: new Date().toISOString()
      });
      return;
    }

    recordSessionStart(apiKey);
  }

  const session = createSession(deviceId, msg.user_profile, msg.capabilities, msg.request_session_id, apiKey, tierName, {
    robotName: msg.robot_name,
    robotPersonality: msg.robot_personality,
    geminiVoice: msg.gemini_voice,
    robotConfig: msg.robot_config,
    sessionContext: msg.session_context
  });

  const sessionInitResponse = {
    type: 'session_init',
    session_id: session.session_id,
    device_id: deviceId,
    status: session.status,
    tier: session.tier,
    expires_in: Math.floor(SESSION_TTL / 1000),
    ttl: Math.floor(SESSION_TTL / 1000),
    timestamp: new Date().toISOString()
  };

  if (session.robot_config && session.robot_config.has_expressions) {
    sessionInitResponse.commands = [buildExpressionCommand('greeting', { priority: 'high' })];
  }

  publishResponse(deviceId, sessionInitResponse);
}

// ---------------------------------------------------------------------------
// MQTT Event Handlers
// ---------------------------------------------------------------------------
client.on('connect', () => {
  log('MQTT Gateway connected to broker');
  client.subscribe('aimeecloud/device/+/connect');
  client.subscribe('aimeecloud/device/+/in');
  client.subscribe('aimeecloud/device/+/system/in');
  log('Subscribed to aimeecloud/device/+/connect, aimeecloud/device/+/in, and aimeecloud/device/+/system/in');
});

client.on('message', async (topic, message) => {
  try {
    const payload = JSON.parse(message.toString());
    const parts = topic.split('/');
    const deviceId = parts[2];

    log('Received on', topic, 'type:', payload.type, 'payload:', payload);

    if (topic.endsWith('/connect')) {
      await handleConnect(deviceId, payload);
    } else if (topic.endsWith('/system/in')) {
      await handleSystemIn(deviceId, payload);
    } else if (topic.endsWith('/in')) {
      if (payload.type === 'disconnect') {
        if (payload.session_id) markDisconnected(payload.session_id);
      } else if (payload.type === 'game_move') {
        await handleGameMove(deviceId, payload);
      } else if (payload.type === 'AimeeAgent') {
        await handleAimeeAgent(deviceId, payload);
      } else if (payload.type === 'snapshot_response') {
        await handleSnapshotResponse(deviceId, payload);
      } else if (payload.type === 'ping') {
        publishResponse(deviceId, {
          type: 'response',
          sub_type: 'pong',
          device_id: deviceId,
          session_id: payload.session_id,
          voice: resolveVoice('aimee-default'),
          timestamp: new Date().toISOString()
        });
      } else {
        await handleIntent(deviceId, payload);
      }
    }
  } catch (err) {
    log('Error handling message:', err.message);
  }
});

client.on('error', (err) => {
  log('MQTT error:', err.message);
});

// Graceful disconnect tracking via LWT is not implemented here because devices
// manage their own connect/disconnect at the MQTT layer. We use session TTL
// as the resiliency mechanism.

log('AimeeCloud MQTT Gateway starting...');
log('ElevenLabs TTS:', ELEVENLABS_ENABLED ? 'enabled' : 'disabled', '| Default TTS mode:', DEFAULT_TTS_MODE);

// ---------------------------------------------------------------------------
// Module Exports (for Game Creation Agent and Audio Gateway integration)
// ---------------------------------------------------------------------------
module.exports = {
  registerGameEngine,
  unregisterGameEngine,
  loadEnginesFromDisk,
  resolveGameEngine,
  gameEngines,
  startGame,
  processGameMove,
  normalizeCapabilities,
  normalizeRobotConfig,
  normalizeSessionContext,
  resolveVoice,
  callLLM,
  sessions,
  getSession,
  createSession,
  publishResponse,
  client,
  buildExpressionCommand,
  getTierForApiKey,
  getTierConfig,
  checkApiRateLimit,
  incrementApiCall
};
