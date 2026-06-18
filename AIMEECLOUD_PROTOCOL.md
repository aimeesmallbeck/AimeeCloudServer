# AimeeCloud Robot Protocol Specification

**Version:** 1.5  
**Date:** 2026-04-25

---

## 1. Overview

AimeeCloud uses MQTT as the primary transport layer between robots (clients) and the cloud gateway. All messages are JSON-encoded. The protocol supports session management, keyword-based intent routing, game state handling, LLM-driven agent mode (`AimeeAgent`), and voice-directed TTS responses.

**Native Audio Streaming (v1.5):** Robots may optionally open a bidirectional WebSocket to `wss://aimeecloud.com/ws/v1` for real-time audio conversation with an audio-native LLM (Gemini Live or OpenAI Realtime). The MQTT channel remains the command-and-control transport. See §9 for the audio streaming protocol.

---

## 2. Topic Structure

| Direction | Topic Pattern | Description |
|-----------|---------------|-------------|
| Client → Cloud | `aimeecloud/device/<deviceId>/connect` | Session initiation / resume |
| Client → Cloud | `aimeecloud/device/<deviceId>/in` | General inbound messages (intent, game moves, pings, agent requests, snapshot responses) |
| Cloud → Client | `aimeecloud/device/<deviceId>/out` | Responses from the gateway |
| Cloud → Client | `aimeecloud/device/<deviceId>/status` | Status updates |
| Cloud → Client | `aimeecloud/device/<deviceId>/system` | Operational / system messages |

**WebSocket Audio Streaming:**
| Direction | Endpoint | Description |
|-----------|----------|-------------|
| Client ↔ Cloud | `wss://aimeecloud.com/ws/v1` | Bidirectional audio streaming (opt-in) |

`<deviceId>` is a stable identifier unique to each robot (e.g., `arduino-uno-q-001`).

---

## 3. Session Management

### 3.1 Connect
**Publish to:** `aimeecloud/device/<deviceId>/connect`

```json
{
  "type": "connect",
  "user_profile": { "name": "BrowserTester", "location": "web" },
  "capabilities": { "input": ["text"], "output": ["display", "tts"] },
  "tts_mode": "client",
  "request_session_id": "sess_abc123"
}
```

- If `request_session_id` is provided and valid for the same device, the session is resumed.
- Otherwise, a new session is created.

### 3.2 Session Init Response
**Received on:** `aimeecloud/device/<deviceId>/out`

**Success:**
```json
{
  "type": "session_init",
  "session_id": "sess_abc123",
  "device_id": "arduino-uno-q-001",
  "status": "connected",
  "tier": "free",
  "expires_in": 600,
  "ttl": 600,
  "commands": [
    { "type": "expression", "name": "greeting", "priority": "high", "duration_ms": 0, "params": {} }
  ],
  "timestamp": "2026-04-16T07:00:00.000Z"
}
```

The `commands` array may contain an initial `expression` command (e.g., `greeting`) that the robot should execute upon connection.

**Rejection — Invalid API Key:**
```json
{
  "type": "session_init",
  "device_id": "arduino-uno-q-001",
  "status": "rejected",
  "error": "INVALID_API_KEY",
  "error_detail": "The provided API key is not recognized.",
  "timestamp": "2026-04-16T07:00:00.000Z"
}
```

**Rejection — Tier Limit Exceeded:**
```json
{
  "type": "session_init",
  "device_id": "arduino-uno-q-001",
  "status": "rejected",
  "error": "TIER_LIMIT_EXCEEDED",
  "error_detail": "Max concurrent sessions (2) reached for Hobbyist tier.",
  "timestamp": "2026-04-16T07:00:00.000Z"
}
```

Possible `error` codes for rejections:
| Code | Meaning |
|------|---------|
| `INVALID_API_KEY` | The `api_key` provided in the connect message is unknown or disabled. |
| `TIER_LIMIT_EXCEEDED` | The key has hit its concurrent-session or daily-session cap. |

### 3.3 Disconnect
**Publish to:** `aimeecloud/device/<deviceId>/in`

```json
{
  "type": "disconnect",
  "device_id": "arduino-uno-q-001",
  "session_id": "sess_abc123"
}
```

Sessions expire after 10 minutes of being disconnected or 20 minutes of idle inactivity.

### 3.4 Tiered Access

AimeeCloud supports tiered access for different use cases:

| Tier | Description | Limits |
|------|-------------|--------|
| `free` | Hobbyist / testing | 2 concurrent sessions, 10 sessions/day, 5 API calls/min, 1 audio stream |
| `paid` | Manufacturer / production | Unlimited sessions, API calls, and audio streams |

**API Key:**
- Robots can include an `api_key` field in their connect message
- API keys are mapped to tiers via the gateway's `tier-config.json`
- If no API key is provided, the session has `tier: null` (unlimited access for backward compatibility)
- The gateway also accepts `X-API-Key` or `x-api-key` as alternative field names

**API keys are obtained via the AimeeCloud web dashboard** (`https://aimeecloud.com/api-keys.html`). Users authenticate with Google OAuth, then generate, label, enable/disable, and delete keys. The dashboard is backed by these HTTP endpoints:

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/aimeecloud-api/auth/me` | Cookie | Return current user (`{ id, email }`). |
| `POST` | `/aimeecloud-api/keys` | Cookie | Create a key. Body: `{ label, tier }`. Returns full key string once. |
| `GET` | `/aimeecloud-api/keys` | Cookie | List keys (masked: `ac_free_…xxxx`). |
| `PATCH` | `/aimeecloud-api/keys/:id` | Cookie | Enable/disable key. Body: `{ is_disabled }`. |
| `DELETE` | `/aimeecloud-api/keys/:id` | Cookie | Permanently delete a key. |

**Connect with API key:**
```json
{
  "type": "connect",
  "api_key": "ac_free_demo_12345",
  "user_profile": { "name": "MyRobot", "location": "lab" },
  "capabilities": { "input": ["text"], "output": ["tts"] },
  "tts_mode": "client"
}
```

**Session Init with tier:**
```json
{
  "type": "session_init",
  "session_id": "sess_abc123",
  "device_id": "my-robot-001",
  "status": "connected",
  "tier": "free",
  "expires_in": 600,
  "ttl": 600,
  "timestamp": "2026-04-17T09:00:00.000Z"
}
```

**Tier Effects on TTS Mode**
If the robot does not explicitly send `tts_mode` in the connect message, the gateway assigns a default based on the resolved tier:

| Tier | Default `tts_mode` | Rationale |
|------|-------------------|-----------|
| `free` | `client` | Free tier does not include server-side TTS. |
| `paid` | `server` | Paid tier can use cloud-generated audio (ElevenLabs) when configured. |
| `null` (no key) | `client` | Backward-compatible default. |

The robot may still override this by sending `tts_mode` explicitly. The gateway respects the robot's preference when it is provided.

---

## 4. Inbound Message Types (`…/in`)

### 4.1 Intent (`intent`)
Routes through the built-in keyword classifier.

```json
{
  "type": "intent",
  "session_id": "sess_abc123",
  "payload": "What is the weather?"
}
```

Supported intents include: `weather`, `news`, `story`, `game`, `help`, `status`, robot movement (`robot_forward`, `robot_backward`, `robot_left`, `robot_right`, `robot_stop`, `robot_wave`), arm control (`arm_raise`, `arm_lower`), and gripper control (`gripper_open`, `gripper_close`). Unmatched input falls back to `chat`.

### 4.2 Game Move (`game_move`)
Sends a move to the currently active game.

```json
{
  "type": "game_move",
  "session_id": "sess_abc123",
  "game": "tic-tac-toe",
  "move": { "position": 4 }
}
```

Supported games: `tic-tac-toe`, `chess`, `yahtzee`, `candyland` (plus AI-generated games).

### 4.3 Ping (`ping`)

```json
{
  "type": "ping",
  "session_id": "sess_abc123"
}
```

Response: `sub_type: "pong"`.

### 4.4 AimeeAgent (`AimeeAgent`)
Bypasses the keyword router and sends the request directly to the LLM agent. The agent generates both a conversational reply and any robot-specific commands needed to fulfill the action.

```json
{
  "type": "AimeeAgent",
  "session_id": "sess_abc123",
  "payload": "Look at the red block and tell me what you see"
}
```

**Response:**

```json
{
  "type": "response",
  "sub_type": "aimee_agent",
  "session_id": "sess_abc123",
  "device_id": "arduino-uno-q-001",
  "text": "Sure, let me take a look.",
  "tts": "Sure, let me take a look.",
  "voice": {
    "persona": "aimee-default",
    "id": "sarah",
    "provider": "lemonfox",
    "lang": "en"
  },
  "commands": [
    { "type": "snapshot", "camera": "front", "purpose": "analysis" }
  ],
  "context": {
    "active_context": null,
    "context_stack": []
  },
  "timestamp": "2026-04-16T07:00:00.000Z"
}
```

#### Command Reference for AimeeAgent
The `commands` array may contain any of the following objects:

| Action | Example Command |
|--------|-----------------|
| Motor | `{ "type": "motor", "action": "forward", "duration_ms": 1000 }` |
| Arm | `{ "type": "arm", "action": "raise" }` |
| Gripper | `{ "type": "gripper", "action": "open" }` |
| Camera snapshot | `{ "type": "snapshot", "camera": "front", "purpose": "analysis" }` |
| Game move | `{ "type": "game_move", "game": "tic-tac-toe", "position": 4 }` |
| Expression | `{ "type": "expression", "name": "happy", "duration_ms": 2500, "priority": "high", "params": { "variant": "celebration", "intensity": 1.0 } }` |

Robots MUST execute `commands` in the order provided after (or concurrently with) playing the `tts` response.

---

## 5. Response Sub-Types (`…/out`)

| `sub_type` | Description |
|------------|-------------|
| `chat_response` | General text/tts reply (from keyword routing or LLM fallback). |
| `robot_command` | Keyword-routed robot action; `command` field contains the directive. |
| `game_update` | Game state update; includes `game`, `state`, `text`, `tts`, `voice`, and optional `commands` for physical actions (snapshot, arm, etc.). |
| `aimee_agent` | LLM-agent reply with `voice`, optional `voice_segments`, and `commands`. |
| `pong` | Reply to a `ping`. |
| `error` | Error condition; includes `error` code, human-readable `text`/`tts`, and `voice`. See §5.1 for common error codes. |

### 5.1 Common Error Codes

Error responses use `sub_type: "error"` and always include an `error` string plus human-readable `text` and `tts`.

| Code | When It Occurs | Example `text` / `tts` |
|------|---------------|------------------------|
| `SESSION_NOT_FOUND` | The `session_id` in an inbound message does not exist or has expired. | "Session not found. Please reconnect." |
| `INVALID_API_KEY` | The `api_key` in the connect message is unknown or disabled. | "The provided API key is not recognized." |
| `TIER_LIMIT_EXCEEDED` | The API key has reached its concurrent-session or daily-session limit. | "Max concurrent sessions (2) reached for Hobbyist tier." |
| `RATE_LIMIT_EXCEEDED` | The API key has exceeded its per-minute API call limit. | "Rate limit exceeded. Max 5 API calls per minute for your tier." |
| `NO_ACTIVE_GAME` | A `game_move` is sent but no game is in progress. | "No active game. Say play tic tac toe to start one." |
| `INVALID_GAME_MOVE` | The move format is wrong or illegal for the current game state. | "Invalid move. Say a number 1-9 or a position like center, top left." |
| `GAME_START_ERROR` | The requested game engine failed to initialize. | "Unknown game: chess" |
| `INVALID_API_KEY` | The `api_key` in the connect message is unknown or disabled. | "The provided API key is not recognized." |
| `TIER_LIMIT_EXCEEDED` | The API key has reached its concurrent-session or daily-session limit. | "Max concurrent sessions (2) reached for Hobbyist tier." |
| `PROVIDER_ERROR` | The audio-native LLM provider returned an error. | "Audio provider error." |
| `PROVIDER_CONNECT_FAILED` | The gateway could not connect to the audio-native LLM. | "Audio provider unavailable." |

**Example error response:**
```json
{
  "type": "response",
  "sub_type": "error",
  "device_id": "arduino-uno-q-001",
  "session_id": "sess_abc123",
  "error": "RATE_LIMIT_EXCEEDED",
  "text": "Rate limit exceeded. Max 5 API calls per minute for your tier.",
  "tts": "Rate limit exceeded. Max 5 API calls per minute for your tier.",
  "voice": {
    "persona": "aimee-default",
    "provider": "lemonfox",
    "id": "sarah",
    "lang": "en"
  },
  "timestamp": "2026-04-16T07:00:00.000Z"
}
```

---

## 6. Voice Metadata (v1.3)

Every outbound response (except `session_init`) now includes a `voice` object that tells the robot which TTS voice to use. The robot is responsible for mapping the `voice.id` to its local Lemonfox primary voice, falling back to gTTS if the voice is unavailable.

Robots that support server-side audio synthesis can set `tts_mode: "server"` in their `connect` message. When server-side generation is enabled and available, responses may include a `tts_audio` field containing a base64-encoded MP3. Robots SHOULD prefer `tts_audio` when present and fall back to local synthesis via `voice` metadata otherwise.

### 6.1 `voice` object

```json
{
  "voice": {
    "persona": "aimee-default",
    "provider": "lemonfox",
    "id": "sarah",
    "lang": "en",
    "description": "Warm, friendly default Aimee voice"
  }
}
```

### 6.2 `voice_segments` (optional)
For rich storytelling or multi-character dialogue, `aimee_agent` responses may include `voice_segments`:

```json
{
  "voice_segments": [
    { "speaker": "Narrator", "text": "Once upon a time...", "voice": "narrator" },
    { "speaker": "Dragon", "text": "Roar!", "voice": "character-dragon" }
  ]
}
```

When `voice_segments` is present, the robot SHOULD synthesize and play each segment sequentially in order, using the per-segment `voice` mapped through the voice registry.

### 6.3 `tts_audio` (optional)

When `tts_mode` is `"server"` and the gateway has an ElevenLabs API key configured, outbound responses may include a pre-generated audio payload:

```json
{
  "tts_audio": {
    "format": "mp3",
    "audio_base64": "//uQxAAAA...",
    "provider": "elevenlabs",
    "voice_id": "XB0fDUnXU5powFXDhCwa"
  }
}
```

- `format` — audio encoding (`mp3`).
- `audio_base64` — the full synthesized audio as a base64 string.
- `provider` — the TTS provider that generated the audio.
- `voice_id` — the provider-specific voice ID used.

If `tts_audio` is absent (e.g., generation failed or timed out), the robot MUST fall back to local synthesis using the `voice` metadata.

### 6.4 Voice Personas
The gateway maintains a `voiceRegistry.json` that maps abstract personas to concrete provider voice IDs. Suggested personas include:

| Persona | Example ID | Use Case |
|---------|------------|----------|
| `aimee-default` | `sarah` | Normal conversational replies |
| `aimee-surprised` | `jessica` | Expressive reactions |
| `aimee-calm` | `echo` | Soothing / reassuring tone |
| `narrator` | `liam` | Story narration |
| `character-wizard` | `adam` | Elderly male character |
| `character-dragon` | `onyx` | Deep, gruff creature |
| `character-fairy` | `fable` | Light, playful voice |
| `game-announcer` | `echo` | Neutral game updates |

---

## 7. Snapshot Request / Response

When the cloud needs a camera image (via AimeeAgent or the audio pipeline's `take_snapshot` function), it publishes a `snapshot_request` to `…/out`:

```json
{
  "type": "snapshot_request",
  "session_id": "sess_abc123",
  "device_id": "arduino-uno-q-001",
  "request_id": "snap_7f8a9b",
  "camera": "front",
  "purpose": "analysis",
  "timestamp": "2026-04-25T12:00:00.000Z"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | `"snapshot_request"` |
| `session_id` | string | Active session ID |
| `device_id` | string | Robot device ID |
| `request_id` | string | Unique ID for this request |
| `camera` | string | Camera identifier (e.g., `front`, `rear`) |
| `purpose` | string | Reason for the snapshot (e.g., `analysis`, `game_board`) |

The robot must respond on `…/in` with:

```json
{
  "type": "snapshot_response",
  "session_id": "sess_abc123",
  "device_id": "arduino-uno-q-001",
  "request_id": "snap_7f8a9b",
  "success": true,
  "message": "Snapshot captured",
  "format": "jpeg",
  "image_base64": "/9j/4AAQSkZJRgABAQAAAQABAAD...",
  "timestamp": "2026-04-25T12:00:02.000Z"
}
```

**Timeout:** The audio pipeline waits **8 seconds** for a `snapshot_response`. The legacy pipeline uses a 15-second stall-detection window.

---

## 8. System Messages (`…/system`)

Sent by operators or deployment tools via `send-system-message.js`.

```json
{
  "type": "protocol_update",
  "device_id": "arduino-uno-q-001",
  "msg_id": "proto-v1.4-20260422",
  "timestamp": "2026-04-22T07:00:00.000Z",
  "version": "1.4"
}
```

Supported system message types:
- `protocol_update`
- `config_update`
- `diagnostics_request`
- `restart`
- `firmware_available`

---

## 9. Native Audio Streaming Protocol (WebSocket `/ws/v1`)

This is an **optional, opt-in** companion transport for conversational audio. The existing MQTT protocol remains unchanged.

### 9.1 Connection Handshake

**Robot → Cloud (first message after WS open):**
```json
{
  "type": "session_start",
  "api_key": "YOUR_API_KEY_HERE",
  "device_id": "arduino-uno-q-001",
  "session_id": "sess_abc123",
  "provider": "gemini",
  "capabilities": {
    "audio_in": {"codec": "opus", "sample_rate": 16000, "channels": 1},
    "audio_out": {"codec": "opus", "sample_rate": 24000, "channels": 1}
  },
  "timestamp": "2026-04-25T12:00:00Z"
}
```

**Cloud → Robot:**
```json
{
  "type": "session_ready",
  "session_id": "sess_abc123",
  "status": "connected",
  "server_info": {
    "model": "gemini-2.5-flash-native-audio",
    "supported_codecs": ["opus", "pcm16"],
    "provider": "gemini"
  }
}
```

### 9.2 Audio Up (Robot → Cloud)

**Binary mode** (when `audio_in.codec` is `opus`): raw Opus packet per 20ms frame.

**JSON mode** (when `audio_in.codec` is `pcm16`):
```json
{
  "type": "audio_chunk",
  "seq": 42,
  "format": "pcm16",
  "sample_rate": 16000,
  "data": "//uQxAAAA..."
}
```

### 9.3 Audio Down (Cloud → Robot)

Same binary or JSON format as Audio Up.

### 9.4 Events

**Robot → Cloud (VAD state change):**
```json
{
  "type": "vad_event",
  "event": "speech_start",
  "timestamp_ms": 1234567
}
```

**Robot → Cloud (barge-in / interrupt):**
```json
{
  "type": "interrupt"
}
```

**Cloud → Robot (function call being executed):**
```json
{
  "type": "function_call_start",
  "call_id": "call_abc",
  "name": "game_move"
}
```

**Cloud → Robot (function call completed):**
```json
{
  "type": "function_call_end",
  "call_id": "call_abc",
  "duration_ms": 150
}
```

**Cloud → Robot (user barge-in detected by provider):**
```json
{
  "type": "interrupted"
}
```

**Cloud → Robot (error):**
```json
{
  "type": "error",
  "code": "RATE_LIMIT_EXCEEDED",
  "message": "Audio streaming rate limit reached",
  "recoverable": true
}
```

### 9.5 Supported Function Calls

When using the audio-native pipeline, the LLM may call these functions:

| Function | Description |
|----------|-------------|
| `game_move` | Make a move in an active game |
| `motor_command` | Control robot base movement (`forward`, `backward`, `left`, `right`, `stop`, `wave`) |
| `arm_command` | Control robot arm (`raise`, `lower`, `extend`, `retract`, `home`) |
| `gripper_command` | Control gripper (`open`, `close`, `half_open`) |
| `take_snapshot` | Capture a camera image |
| `set_expression` | Trigger emotional expression (`happy`, `sad`, `surprised`, `greeting`, `celebration`) |
| `get_robot_status` | Get current robot telemetry |

### 9.6 Backward Compatibility

- The audio pipeline is **opt-in**. Robots that do not connect to `/ws/v1` continue to use the legacy text-based voice manager.
- All robot commands (motor, arm, gripper, snapshot, expression) are still sent via MQTT `…/out` regardless of which voice pipeline is active.

---

## 10. Change Log

### v1.5 — 2026-04-25
- Added Native Audio Streaming protocol over WebSocket (`wss://aimeecloud.com/ws/v1`).
- Documented bidirectional audio streaming: `session_start`, `session_ready`, `audio_chunk`, `vad_event`, `interrupt`, `function_call_start`, `function_call_end`, `interrupted`.
- Documented audio-native LLM function calls (`game_move`, `motor_command`, `arm_command`, `gripper_command`, `take_snapshot`, `set_expression`, `get_robot_status`).
- Added `snapshot_request` / `snapshot_response` schemas with `request_id`, `camera`, and `purpose`.
- Added `chess` to supported games list.
- Added audio-provider error codes (`PROVIDER_ERROR`, `PROVIDER_CONNECT_FAILED`).
- Documented tier-based audio stream limits (`max_concurrent_audio_streams`).

### v1.4 — 2026-04-22
- Documented Google OAuth authentication flow and API key HTTP endpoints (`/api/auth/*`, `/api/keys`).
- Documented session-init rejection responses: `INVALID_API_KEY` and `TIER_LIMIT_EXCEEDED`.
- Documented `commands` array in `session_init` (e.g., `expression:greeting`).
- Documented `expression` command type in AimeeAgent command reference.
- Added §5.1 Common Error Codes with full list of `error` values robots may receive.
- Documented tier-based default `tts_mode` assignment when the robot does not specify one.

### v1.3 — 2026-04-17
- Added ElevenLabs as a server-side TTS provider with fallback chain support in `voiceRegistry.json`.
- Added optional `tts_mode` to connect messages (`"client"` or `"server"`).
- Added optional `tts_audio` field to outbound responses for robots that support cloud-generated audio playback.
- `voice` metadata now represents the first client-side fallback provider (e.g., Lemonfox or gTTS).

### v1.2 — 2026-04-16
- Added `voice` metadata to all outbound response types.
- Added optional `voice_segments` array for multi-character TTS (stories, dramatic readings).
- AimeeAgent LLM prompt updated to select voice persona and emit `voice_segments` when appropriate.
- Game engines are now capability-aware. `game_update` responses may include `commands` (e.g., `snapshot` to show the board after a move) based on the robot's hardware capabilities.

### v1.1 — 2026-04-16
- Added `AimeeAgent` inbound message type and `aimee_agent` response sub-type.
- Agents can now return structured `commands` alongside conversational replies.
- Existing keyword router, game engines, and session logic remain unchanged.
