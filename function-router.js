/**
 * Function Call Router
 *
 * Routes audio-native LLM function calls to existing AimeeCloud systems:
 *   - Game engines (existing processGameMove / startGame)
 *   - MQTT robot commands
 *   - Snapshot service (request/response over MQTT)
 *   - Session / robot status queries
 */

const mqtt = require('mqtt');
const crypto = require('crypto');
const https = require('https');

// Import existing gateway modules
const mqttGateway = require('./aimeecloud-mqtt-gateway');

const MQTT_BROKER = 'mqtt://127.0.0.1:1883';
const SNAPSHOT_TIMEOUT_MS = 8000;

// Dedicated MQTT client for function-router (avoids interfering with main gateway loop)
let _mqttClient = null;
let _mqttReady = false;
const _snapshotWaiters = new Map(); // requestId -> { resolve, reject, timeout }

function getMqttClient() {
  if (_mqttClient) return _mqttClient;
  _mqttClient = mqtt.connect(MQTT_BROKER);

  _mqttClient.on('connect', () => {
    _mqttReady = true;
    _mqttClient.subscribe('aimeecloud/device/+/in');
  });

  _mqttClient.on('message', (topic, message) => {
    try {
      const payload = JSON.parse(message.toString());
      if (payload.type === 'snapshot_response' && payload.request_id) {
        const waiter = _snapshotWaiters.get(payload.request_id);
        if (waiter) {
          clearTimeout(waiter.timeout);
          _snapshotWaiters.delete(payload.request_id);
          waiter.resolve(payload);
        }
      }
    } catch {
      // ignore parse errors
    }
  });

  _mqttClient.on('error', (err) => {
    console.error('[FunctionRouter] MQTT error:', err.message);
  });

  return _mqttClient;
}

function isoNow() {
  return new Date().toISOString();
}

function buildAimeeAgentPayload(deviceId, sessionId, commands) {
  return {
    type: 'AimeeAgent',
    session_id: sessionId,
    device_id: deviceId,
    commands,
    timestamp: isoNow()
  };
}

function buildRobotCommandResponse(session, text, tts, commandOrCommands) {
  const payload = {
    type: 'response',
    sub_type: 'robot_command',
    session_id: session.session_id,
    device_id: session.device_id,
    text,
    tts,
    voice: mqttGateway.resolveVoice(session.voice_persona || 'aimee-default'),
    timestamp: isoNow()
  };
  if (commandOrCommands) {
    if (Array.isArray(commandOrCommands)) payload.commands = commandOrCommands;
    else payload.command = commandOrCommands;
  }
  return payload;
}

function publishResponse(session, payload) {
  const client = getMqttClient();
  client.publish(`aimeecloud/device/${session.device_id}/out`, JSON.stringify(payload));
}

async function waitForSnapshot(session, requestId, camera = 'front', purpose = 'analysis') {
  const client = getMqttClient();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      _snapshotWaiters.delete(requestId);
      reject(new Error('Snapshot timeout'));
    }, SNAPSHOT_TIMEOUT_MS);

    _snapshotWaiters.set(requestId, { resolve, reject, timeout });

    // Publish request
    const topic = `aimeecloud/device/${session.device_id}/out`;
    client.publish(topic, JSON.stringify({
      type: 'snapshot_request',
      session_id: session.session_id,
      device_id: session.device_id,
      request_id: requestId,
      camera,
      purpose,
      timestamp: isoNow()
    }));
  });
}

// ---------------------------------------------------------------------------
// Function Handlers
// ---------------------------------------------------------------------------

async function handleGameMove(session, args) {
  const gameName = args.game;
  let move = args.move || {};

  if (!gameName) {
    return { error: 'Missing "game" parameter.' };
  }

  // Normalize row/col to position for tic-tac-toe
  if (gameName === 'tic-tac-toe' && move.row !== undefined && move.col !== undefined) {
    move = { ...move, position: move.row * 3 + move.col };
  }

  // Diagnostics: log session state before processing
  const hasState = !!(session.state_data && session.state_data[gameName]);
  console.log('[FunctionRouter] game_move | session:', session.session_id, '| active_context:', session.active_context, '| hasState:', hasState, '| move:', JSON.stringify(move));

  // Auto-start game if not active
  const activeGame = session.active_context && session.active_context.startsWith('Game:')
    ? session.active_context.replace('Game: ', '')
    : null;

  if (!activeGame || activeGame !== gameName) {
    console.log('[FunctionRouter] Auto-starting game', gameName, 'for session', session.session_id, '(activeGame was:', activeGame, ')');
    const startResult = await mqttGateway.startGame(session, gameName);
    if (startResult.error) {
      return { error: startResult.error };
    }
  }

  const result = await mqttGateway.processGameMove(session, gameName, move);
  console.log('[FunctionRouter] processGameMove result:', JSON.stringify(result).slice(0, 400));
  if (result.error) {
    return { error: result.error };
  }

  return {
    status: 'ok',
    game: gameName,
    text: result.text,
    tts: result.tts,
    state: result.state
  };
}

async function handleMotorCommand(session, args) {
  const MOTOR_LABELS = {
    forward: { text: 'Moving forward', tts: 'Okay, moving forward' },
    backward: { text: 'Moving backward', tts: 'Okay, moving backward' },
    left: { text: 'Turning left', tts: 'Okay, turning left' },
    right: { text: 'Turning right', tts: 'Okay, turning right' },
    stop: { text: 'Stopping', tts: 'Okay, stopping' },
    wave: { text: 'Waving hello!', tts: 'Hello! Wave wave!' }
  };
  const action = args.action || 'stop';
  const duration = args.duration_ms || (action === 'wave' ? 1000 : action === 'stop' ? 0 : 1000);
  const label = MOTOR_LABELS[action] || { text: `Motor ${action}`, tts: `Okay, ${action}` };
  const command = { motor: action, duration_ms: duration };
  publishResponse(session, buildRobotCommandResponse(session, label.text, label.tts, command));
  return { status: 'dispatched', command: 'motor_command', action };
}

async function handleArmCommand(session, args) {
  const ARM_LABELS = {
    raise: { text: 'Raising arm', tts: 'Okay, raising the arm' },
    lower: { text: 'Lowering arm', tts: 'Okay, lowering the arm' },
    extend: { text: 'Extending arm', tts: 'Okay, extending the arm' },
    retract: { text: 'Retracting arm', tts: 'Okay, retracting the arm' },
    home: { text: 'Returning arm to home', tts: 'Okay, returning the arm to home' }
  };
  const action = args.action || 'home';
  const label = ARM_LABELS[action] || { text: `Arm ${action}`, tts: `Okay, arm ${action}` };
  const command = { arm: action };
  publishResponse(session, buildRobotCommandResponse(session, label.text, label.tts, command));
  return { status: 'dispatched', command: 'arm_command', action };
}

async function handleGripperCommand(session, args) {
  const GRIPPER_LABELS = {
    open: { text: 'Opening gripper', tts: 'Okay, opening the gripper' },
    close: { text: 'Closing gripper', tts: 'Okay, closing the gripper' },
    half_open: { text: 'Opening gripper halfway', tts: 'Okay, opening the gripper halfway' }
  };
  const action = args.action || 'open';
  const label = GRIPPER_LABELS[action] || { text: `Gripper ${action}`, tts: `Okay, gripper ${action}` };
  const command = { gripper: action };
  publishResponse(session, buildRobotCommandResponse(session, label.text, label.tts, command));
  return { status: 'dispatched', command: 'gripper_command', action };
}

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';

async function analyzeImageWithVisionLLM(base64Image, prompt) {
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

async function handleTakeSnapshot(session, args) {
  const requestId = 'snap_' + crypto.randomBytes(4).toString('hex');
  try {
    const response = await waitForSnapshot(
      session,
      requestId,
      args.camera || 'front',
      args.purpose || 'analysis'
    );

    let analysis = '';
    if (response.image_base64) {
      const analysisPrompt = args.analysis_prompt ||
        'Analyze this image from a robot camera. Describe the scene in detail. Identify any objects, their colors, and their approximate positions (e.g., center, upper left, lower right). If there is a pink character and a blue tape target, describe their exact locations relative to each other and to the frame.';
      analysis = await analyzeImageWithVisionLLM(response.image_base64, analysisPrompt);
    }

    return {
      status: 'captured',
      format: response.format || 'jpeg',
      image_base64: response.image_base64 || response.data || '',
      analysis: analysis
    };
  } catch (err) {
    return {
      status: 'error',
      error: 'Snapshot failed: ' + err.message,
      recoverable: true
    };
  }
}

async function handleSetExpression(session, args) {
  const name = args.name || 'happy';
  const duration = args.duration_ms || 2500;
  const priority = args.priority || 'normal';
  const command = {
    type: 'expression',
    name,
    duration_ms: duration,
    priority
  };
  const text = `Setting expression to ${name}`;
  publishResponse(session, buildRobotCommandResponse(session, text, text, [command]));
  return { status: 'dispatched', command: 'set_expression', name };
}

async function handleGetRobotStatus(session, args) {
  // Build status from session data
  const status = {
    device_id: session.device_id,
    session_id: session.session_id,
    status: session.status,
    active_context: session.active_context,
    capabilities: session.capabilities,
    robot_config: session.robot_config,
    session_context: session.session_context,
    tier: session.tier,
    last_activity: session.last_activity,
    voice_persona: session.voice_persona
  };
  return status;
}

// ---------------------------------------------------------------------------
// Main Router
// ---------------------------------------------------------------------------

const HANDLERS = {
  game_move: handleGameMove,
  motor_command: handleMotorCommand,
  arm_command: handleArmCommand,
  gripper_command: handleGripperCommand,
  take_snapshot: handleTakeSnapshot,
  set_expression: handleSetExpression,
  get_robot_status: handleGetRobotStatus
};

/**
 * Execute a function call against local services.
 * @param {object} call — { id, name, args }
 * @param {object} session — AimeeCloud session object
 * @returns {Promise<object>} — Result to send back to LLM
 */
async function executeFunction(call, session) {
  const handler = HANDLERS[call.name];
  if (!handler) {
    return { error: `Unknown function: ${call.name}` };
  }
  return handler(session, call.args || {});
}

/**
 * JSON Schema function declarations for the audio-native LLM.
 */
const FUNCTION_DECLARATIONS = [
  {
    name: 'game_move',
    description: 'Make a move in an active game. For tic-tac-toe, use position (0-8) or a description like "center", "top left". For chess, use standard algebraic notation like "e2e4".',
    parameters: {
      type: 'object',
      properties: {
        game: { type: 'string', enum: ['tic-tac-toe', 'chess', 'yahtzee', 'candyland'] },
        move: {
          type: 'object',
          description: 'Move details. For tic-tac-toe, include "position" (number 0-8) or "text" (e.g., "center", "top left").',
          properties: {
            position: { type: 'integer', description: 'Board position index (0-8 for tic-tac-toe)' },
            text: { type: 'string', description: 'Text description of move (e.g., "center", "top left", "4")' },
            row: { type: 'integer', description: 'Row index (0-2) if using grid coordinates' },
            col: { type: 'integer', description: 'Column index (0-2) if using grid coordinates' }
          }
        }
      },
      required: ['game', 'move']
    }
  },
  {
    name: 'motor_command',
    description: 'Control robot base movement',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['forward', 'backward', 'left', 'right', 'stop', 'wave'] },
        duration_ms: { type: 'integer', default: 0 }
      },
      required: ['action']
    }
  },
  {
    name: 'arm_command',
    description: 'Control robot arm',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['raise', 'lower', 'extend', 'retract', 'home'] }
      },
      required: ['action']
    }
  },
  {
    name: 'gripper_command',
    description: 'Control robot gripper',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['open', 'close', 'half_open'] }
      },
      required: ['action']
    }
  },
  {
    name: 'take_snapshot',
    description: 'Capture an image from the robot camera and analyze it. Returns an image analysis describing objects, colors, and positions.',
    parameters: {
      type: 'object',
      properties: {
        camera: { type: 'string', default: 'front' },
        purpose: { type: 'string', default: 'analysis' },
        analysis_prompt: { type: 'string', description: 'Optional custom prompt for vision analysis. Default describes objects and positions.' }
      }
    }
  },
  {
    name: 'set_expression',
    description: 'Trigger an emotional expression on the robot',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', enum: ['happy', 'sad', 'surprised', 'greeting', 'celebration'] },
        duration_ms: { type: 'integer', default: 2500 },
        priority: { type: 'string', enum: ['low', 'normal', 'high'], default: 'normal' }
      },
      required: ['name']
    }
  },
  {
    name: 'get_robot_status',
    description: 'Get current robot telemetry',
    parameters: {
      type: 'object',
      properties: {}
    }
  }
];

module.exports = {
  executeFunction,
  FUNCTION_DECLARATIONS,
  getMqttClient
};
