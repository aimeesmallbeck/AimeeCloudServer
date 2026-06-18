# AimeeCloud Configuration Checkpoint

**Date:** 2026-06-08  
**Last Updated By:** Kimi Code CLI  

---

## 1. Infrastructure & Endpoints

| Service | Endpoint / Port |
|---------|----------------|
| AimeeCloud API | `aimeecloud.com` (production) |
| MQTT Broker (TCP) | `aimeecloud.com:1883` |
| MQTT Broker (WSS) | `wss://aimeecloud.com/aimeecloud-mqtt` |
| Audio Streaming | `wss://aimeecloud.com/ws/v1` (Gemini Live API proxy via Nginx → `127.0.0.1:3080`) |
| API Server | Port `3080` (`aimeecloud-api-v3.js`) |
| Audio Gateway (standalone) | Port `3081` (fallback) |

### Nginx Proxy
```
location /ws/v1 { proxy_pass http://127.0.0.1:3080; }
```

---

## 2. Authentication & API Keys

### Demo Keys (no OAuth required)
| Key | Tier | Limits |
|-----|------|--------|
| `ac_free_demo_12345` | free | Limited audio streams |
| `ac_paid_demo_67890` | paid | Unlimited audio streams |

### LLM / Provider Keys
- **Gemini API Key:** Set in `/workspace/.env.aimeecloud` as `GEMINI_API_KEY`
- **OpenRouter Key:** Set in `/workspace/.env.aimeecloud` as `OPENROUTER_API_KEY` (vision analysis) and `OPENROUTER_HTTP_API_KEY` (HTTP API LLM)

---

## 3. Audio / Voice Configuration

| Setting | Value |
|---------|-------|
| Active Model | `gemini-3.1-flash-live-preview` |
| Previous Model | `gemini-2.5-flash-native-audio-preview` (deprecated) |
| Current Voice | `Fenrir` |
| Voice History | Puck → Charon → Aoede → Fenrir |
| Thinking Config | `MINIMAL` (reduces latency gaps) |
| Input Codec | `pcm16` @ 16 kHz |
| Output Codec | `pcm16` @ 24 kHz |
| Opus Support | Available if `@discordjs/opus` installed |

### Gemini Setup Payload
```js
{
  model: 'models/gemini-3.1-flash-live-preview',
  generationConfig: {
    responseModalities: ['AUDIO'],
    thinkingConfig: { thinkingLevel: 'MINIMAL' },
    speechConfig: {
      voiceConfig: {
        prebuiltVoiceConfig: { voiceName: 'Fenrir' }
      }
    }
  }
}
```

---

## 4. Game Engines

**Source Directory:** `/workspace/game-test/engines/`

| Game | File | Engine Name |
|------|------|-------------|
| Tic-Tac-Toe | `tictactoe.js` | `tic-tac-toe` |
| Chess | `chess.js` | `chess` |
| Yahtzee | `yahtzee.js` | `yahtzee` |
| Candyland | `candyland.js` | `candyland` |

### Tic-Tac-Toe Engine
- **Player Symbol:** `X` (goes first)
- **AI Symbol:** `O`
- **Modes:** `voice+snapshot`, `voice-only`, `display-only`
- **State Mutates In-Place:** Yes (`makeMove` modifies `state.board`, `state.current_turn`, etc.)

### Recent Engine Fixes
- `makeMove` now coerces `position` to integer via `parseInt(position, 10)`
- Rejects moves when `state.status === 'game_over'`

---

## 5. Session & State Management

### Session Architecture
- **Standalone MQTT Process:** `node aimeecloud-mqtt-gateway.js` (handles MQTT device traffic)
- **API Process:** `node aimeecloud-api-v3.js` (loads audio gateway + MQTT gateway module)
- **Sessions Map:** Each process maintains its own `Map` of `session_id → session`
- **Persistence:** `/tmp/aimeecloud-sessions.json` (saved every 15s by both processes — *known race condition*)

### Audio Gateway Session Resolution
1. Look up `session_id` in `mqttGateway.sessions`
2. If not found or `device_id` mismatch → scan all sessions for most recent match by `device_id`
3. If still not found → create lightweight audio session with:
   - `state_data: {}`
   - `game_flags: { voice: true, display: false, snapshot: false, arm: false, platform: false }`

---

## 6. Function Routing (Audio-Native LLM)

**File:** `function-router.js`

### Supported Functions
| Function | Handler |
|----------|---------|
| `game_move` | `handleGameMove` |
| `motor_command` | `handleMotorCommand` |
| `arm_command` | `handleArmCommand` |
| `gripper_command` | `handleGripperCommand` |
| `take_snapshot` | `handleTakeSnapshot` |
| `set_expression` | `handleSetExpression` |
| `get_robot_status` | `handleGetRobotStatus` |

### Game Move Auto-Start Logic
```js
const activeGame = session.active_context && session.active_context.startsWith('Game:')
  ? session.active_context.replace('Game: ', '')
  : null;

if (!activeGame || activeGame !== gameName) {
  await mqttGateway.startGame(session, gameName);  // Resets state_data[gameName]
}
```

### Function Declarations (Gemini Schema)
```js
{
  name: 'game_move',
  parameters: {
    properties: {
      game: { enum: ['tic-tac-toe', 'chess', 'yahtzee', 'candyland'] },
      move: { type: 'object' }
    }
  }
}
```

---

## 7. Active Issues

| Issue | Status | Notes |
|-------|--------|-------|
| **Game State Not Tracking** | **Partially Fixed** | Session fallback + string coercion + game-over guard added. Awaiting robot reconnection to verify. |
| **Dual-Process Session Sync** | **Resolved** | Standalone `aimeecloud-mqtt-gateway.js` removed; only `aimeecloud-api-v3.js` is running and it loads the MQTT gateway module. This eliminates duplicate session creation and `SESSION_NOT_FOUND` races. |
| **Audio Static (robot-side)** | **Open** | Gateway outputs clean PCM16 @ 24kHz. Recommend robot implements 50–100ms playback ring buffer. |

---

## 8. Recent Changes Log

### 2026-06-11 — Robot Configuration Protocol Update
- **Protocol:** Bumped `AimeeCloud-Robot-Protocol-Spec.md` to **v1.4**
- **New session-start fields:** `robot_name`, `robot_personality`, `gemini_voice`, `robot_config`, `session_context`
- **`robot_config` schema:**
  - `has_motors`, `has_arm`, `has_gripper`, `has_camera`, `has_expressions`
  - `expression_types` array
- **`session_context`:** Free-form key-value map for robot specs (RAM, CPU, battery, model, etc.) that the agent can reference during the session.
- **Purpose:** Allows the cloud to tailor the agent prompt, filter function declarations, and answer hardware/spec questions from the provided context.
- **Status:** Protocol spec updated; server-side prompt/function filtering **implemented** on 2026-06-17.

### 2026-06-17 — Robot Configuration Protocol v1.4 Implementation
- **`aimeecloud-mqtt-gateway.js`:**
  - `createSession()` now stores `robot_name`, `robot_personality`, `gemini_voice`, `robot_config`, and `session_context`.
  - `session_init` only sends the greeting expression command when `robot_config.has_expressions` is true.
  - `callAimeeAgentLLM()` injects robot identity, capabilities, and session context into the prompt.
  - Subscribes to `aimeecloud/device/+/system/in` and processes `status_report`, `diagnostics_response`, and `ack`.
  - Publishes `status: expired` messages before removing stale sessions.
- **`aimeecloud-audio-gateway.js`:**
  - `session_start` now reads and stores `robot_name`, `robot_personality`, `gemini_voice`, `robot_config`, and `session_context`.
  - Builds a dynamic system instruction from those fields.
  - Filters function declarations by `robot_config` before sending them to the LLM provider.
  - `gemini_voice` is passed to the Gemini provider instead of always using `Fenrir`.
- **`function-router.js`:**
  - Motor/arm/gripper/expression handlers now publish spec-compliant `response` messages with `sub_type: robot_command`.
  - `snapshot_request` now includes `session_id` and `device_id`.
  - `get_robot_status` now returns `robot_config` and `session_context`.
- **Service architecture:** Removed the standalone MQTT gateway process; only `aimeecloud-api-v3.js` runs, loading both audio and MQTT gateways.

### 2026-06-08 — Game State Tracking Fixes
- **`aimeecloud-audio-gateway.js`:**
  - Added `device_id` fallback when `session_id` lookup fails
  - Added `game_flags` to lightweight audio sessions
  - Updated model name in `session_ready` to `gemini-3.1-flash-live-preview`
- **`function-router.js`:**
  - Added diagnostic logging to `handleGameMove`
- **`tictactoe.js`:**
  - `makeMove` now coerces `position` via `parseInt(position, 10)`
  - Added `state.status === 'game_over'` guard
- **`aimeecloud-mqtt-gateway.js`:**
  - `processGameMove` now parses `move.position` as integer

### 2026-06-08 — Earlier Updates (from context)
- Added Section 10 to `AimeeCloud-Robot-Protocol-Spec.md` (protocol v1.3)
- Updated `aimeecloud-auth.js` demo key fallback
- Added Nginx `/ws/v1` proxy location
- Copied missing gateway files to `/workspace/`
- Updated Gemini model to `gemini-3.1-flash-live-preview`
- Fixed `sendAudio()` from deprecated `mediaChunks` to direct `audio` object
- Fixed game name enum from underscores to hyphens
- Added `thinkingConfig: { thinkingLevel: 'MINIMAL' }`

---

## 9. Log Files

| Log | Path |
|-----|------|
| API Server | `/var/log/aimeecloud-api-v3.log` |
| Audio Gateway | `/var/log/aimeecloud-audio-gateway.log` |
| MQTT Gateway | `/var/log/aimeecloud-mqtt-gateway.log` |
| HTTP Requests | `/var/log/aimeecloud-requests.log` |
| Nginx Access | `/var/log/nginx/access.log` |

---

## 10. Service Restart Procedure

```bash
# Copy deploy files to workspace
sudo cp /home/scott/aimeecloud-deploy/*.js /workspace/
sudo cp /home/scott/aimeecloud-deploy/audio-providers/*.js /workspace/audio-providers/

# Stop both the API server and any leftover standalone MQTT gateway
sudo pkill -f '[a]imeecloud-api-v3[.]js' || true
sudo pkill -f '[a]imeecloud-mqtt-gateway[.]js' || true

cd /workspace
# Source the full .env so AIMEE_DEMO_KEY_* and other vars are available
sudo nohup bash -c 'set -a; source .env.aimeecloud; set +a; node aimeecloud-api-v3.js > /var/log/aimeecloud-api-v3.log 2>&1' &
```
