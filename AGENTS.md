# AimeeCloud — Agent Guide

**Project:** AimeeCloud Robot AI Gateway  
**Language:** English (all docs, comments, and code)  
**Last Updated:** 2026-04-25

---

## 1. Project Overview

AimeeCloud is a cloud-based AI gateway that gives small robots (primarily Arduino UNO Q and similar ROS2 platforms) natural language conversation, games, stories, weather/news responses, and physical command routing without requiring onboard AI hardware.

The system consists of:

- **MQTT Gateway** (`aimeecloud-mqtt-gateway.js`) — The primary runtime (≈1,650 lines). Handles robot connections over MQTT, session lifecycle, intent classification, game state management, LLM agent responses, voice metadata, tiered rate limiting, and on-demand game creation.
- **HTTP API** (`aimeecloud-api-v3.js`) — A REST server on port 3080 for browser clients, auth, API key management, and legacy session endpoints. Has its own in-memory session store (separate from the MQTT gateway).
- **Auth Module** (`aimeecloud-auth.js`) — Shared SQLite-backed auth for both gateways. Manages users, Google OAuth, JWT sessions, API keys, invite requests, and usage logging.
- **Browser Test Client** (`aimee/index.html`) — A standalone HTML/JS MQTT client for manual testing.
- **Robot Simulator** (`aimee/robot-simulator.html`) — Full-featured browser robot simulator with voice input/output panels, display screen, capability toggles, command log, speech recognition/synthesis, and game quick actions. Connects via MQTT over WebSocket.
- **Web Dashboard** (`index.html`, `login.html`, `api-keys.html`, `admin-invites.html`, `invite.html`) — Static pages served via Nginx.
- **Game Creation Agent** (`game-creation-agent/`) — On-demand engine generator. Validates game requests, researches rules, generates JS engines via LLM, sandboxes and tests them, and registers dynamically with the running gateway.
- **DOAgent Listener** (`doagent-listener.js`) — A development-coordination MQTT client that listens for tasks from the multi-agent dev protocol. Connects to an external broker (`209.38.147.67:1883`).
- **System Message Sender** (`send-system-message.js`) — CLI tool to push operational messages to robots via MQTT.
- **ElevenLabs TTS Wrapper** (`elevenlabs-tts.js`) — Server-side TTS generation. Returns base64-encoded MP3.

---

## 2. Technology Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js (JavaScript, CommonJS `require`) |
| Messaging | MQTT via `mqtt` npm package; broker is Mosquitto |
| Database | SQLite3 (`sqlite3` npm package) |
| Auth | JWT (`jsonwebtoken`), Google OAuth 2.0, API keys |
| LLM | OpenRouter API (`google/gemini-2.5-flash-lite` in gateway & game agent; `openrouter/google/gemini-1.5-flash` still present in HTTP API) |
| TTS | ElevenLabs (server-side, optional), Lemonfox/gTTS (client-side fallback) |
| Reverse Proxy | Nginx |
| WebSocket | Mosquitto WebSocket listener on port 9001, proxied via Nginx at `/aimeecloud-mqtt` |
| Deployment | Bash script (`deploy.sh`) + systemd |

**Key npm dependencies:**
- `mqtt` — listed in `package.json`
- `sqlite3`, `jsonwebtoken`, `uuid` — installed at runtime via `deploy.sh` into `/workspace/`

---

## 3. Directory & Code Organization

```
aimeecloud-deploy/
├── aimeecloud-mqtt-gateway.js   # Main MQTT gateway (runtime: /workspace/)
├── aimeecloud-api-v3.js         # HTTP REST API (port 3080)
├── aimeecloud-auth.js           # Shared auth module
├── elevenlabs-tts.js            # ElevenLabs server TTS wrapper
├── doagent-listener.js          # Dev-coordination MQTT listener
├── send-system-message.js       # CLI for system messages to robots
├── deploy.sh                    # Deployment script
├── start-api-service.sh         # Wrapper to start HTTP API with env
├── start-mqtt-gateway.sh        # Wrapper to start MQTT gateway with env
├── package.json                 # Minimal: only mqtt dependency
├── voiceRegistry.json           # Voice persona → provider mappings
├── tier-config.json             # free / paid tier limits
├── mosquitto-websockets.conf    # Mosquitto WebSocket config snippet
├── nginx-snippet.conf           # Nginx snippet (referenced in docs)
├── aimee/
│   ├── index.html               # Browser MQTT test client
│   └── robot-simulator.html     # Full robot simulator with voice/display
├── game-creation-agent/         # On-demand game engine generator
│   ├── agent.js                 # Main orchestrator
│   ├── designer.js              # LLM game design + validation step
│   ├── generator.js             # LLM code generation step
│   ├── validator.js             # Node vm sandbox + contract compliance
│   ├── registry.js              # Save/load/register engines
│   ├── search.js                # LLM-based research (rules + npm libs)
│   └── prompts/                 # Prompt templates
│       ├── design.txt
│       ├── generate.txt
│       └── validate-game.txt
├── docs/
│   └── openapi-spec.yaml        # OpenAPI 3.0 spec
├── tasks/                       # Backlog / task descriptions
│   ├── elevenlabs-tts-integration.md
│   ├── expression-gateway.md
│   ├── expressiveness.md
│   ├── openapi-spec.md
│   ├── tiered-access.md
│   ├── update-protocol.md
│   └── verify-sessions.md
└── *.md                         # Protocol & specification docs
```

**Game engines** are *not* in this repo. They are loaded at runtime from absolute paths:
- `/workspace/game-test/engines/tictactoe.js`
- `/workspace/game-test/engines/yahtzee.js`
- `/workspace/game-test/engines/candyland.js`
- `/workspace/game-test/engines/chess.js`

Engines follow a **universal contract** (`name`, `displayName`, `stationary`, `modes`, `createState`, `makeMove`, `agentMove`, `buildResponse`, `normalizeState`, `reset`, `getHint`, `getRules`). The gateway is fully engine-agnostic and loads engines dynamically from disk. Generated engines are validated in a sandbox before registration.

**Source vs. Runtime:**
- Source of truth is `/home/scott/aimeecloud-deploy/`.
- `deploy.sh` copies `.js`, `.json`, and `.html` files to `/workspace/` and `/var/www/html/aimeecloud/`.
- The HTTP API and MQTT gateway are started from `/workspace/`.

**⚠️ Known Deployment Gap:** `deploy.sh` does **not** copy the `game-creation-agent/` directory to `/workspace/`. Because `aimeecloud-mqtt-gateway.js` requires `./game-creation-agent/agent`, on-demand engine generation will fail when the gateway runs from `/workspace/` unless the directory is also copied or the gateway is run from `/home/scott/aimeecloud-deploy/`.

---

## 4. Build, Run & Test Commands

There is no formal build step (Node.js runs directly). Use the deployment script or manual commands.

### Deployment (production-like)
```bash
# Run as root or with passwordless sudo for systemctl/nginx
bash /home/scott/aimeecloud-deploy/deploy.sh
```

### Manual Development Start
```bash
# 1. Ensure env file exists
cat /workspace/.env.aimeecloud
# Required vars: ELEVENLABS_API_KEY, JWT_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET

# 2. Start MQTT gateway
cd /workspace
source .env.aimeecloud
node aimeecloud-mqtt-gateway.js

# 3. Start HTTP API (in another terminal)
cd /workspace
source .env.aimeecloud
node aimeecloud-api-v3.js
```

### Testing
- **Browser client:** Open `https://aimeecloud.com/aimee` (or the local equivalent). Enter a message and send via MQTT over WebSocket.
- **Robot Simulator:** Open `https://aimeecloud.com/aimee/robot-simulator.html`. Toggle capabilities, use voice input/output panels, view the display screen, and inspect raw MQTT traffic in the command log. Supports Web Speech API for microphone input and TTS output in Chrome.
- **MQTT CLI:**
  ```bash
  mosquitto_sub -h 127.0.0.1 -p 1883 -t "aimeecloud/device/+/out" -v
  mosquitto_pub -h 127.0.0.1 -p 1883 -t "aimeecloud/device/test-001/connect" -m '{"type":"connect","capabilities":{"input":["text"],"output":["tts"]}}'
  ```
- **System message:**
  ```bash
  node send-system-message.js --device arduino-uno-q-001 --type diagnostics_request --msg-id diag-01
  ```
- **No automated unit tests exist.** All testing is currently manual via MQTT clients, browser, or `curl` against the REST API.

---

## 5. Code Style Guidelines

- **Language:** JavaScript (ES6+ where convenient, but no transpiler). Use `const`/`let`, arrow functions, and template strings freely.
- **Modules:** CommonJS (`require` / `module.exports`). No ESM.
- **Formatting:** 2-space indentation. No enforced linter. Follow the existing file's style.
- **Comments:** Use `//` for inline comments. Section headers often use a repeated `//` line followed by a title, e.g.:
  ```js
  // ---------------------------------------------------------------------------
  // Session Management
  // ---------------------------------------------------------------------------
  ```
- **Logging:** The MQTT gateway writes to `/var/log/aimeecloud-mqtt-gateway.log` via a custom `log()` function. The HTTP API logs to `/var/log/aimeecloud-requests.log`. Prefer these over `console.log` in production code.
- **Error Handling:** In async contexts, use `try/catch` around JSON parsing and external API calls. The gateway often resolves promises with fallback strings rather than rejecting, to avoid crashing the MQTT event loop.
- **File Paths:** Prefer absolute paths for runtime resources (`/workspace/...`, `/var/log/...`, `/tmp/...`).

---

## 6. Architecture & Runtime Behavior

### MQTT Topic Structure
| Direction | Topic | Purpose |
|-----------|-------|---------|
| Robot → Cloud | `aimeecloud/device/<id>/connect` | Session init / resume |
| Robot → Cloud | `aimeecloud/device/<id>/in` | Intents, game moves, agent requests, pings, disconnects |
| Cloud → Robot | `aimeecloud/device/<id>/out` | Responses |
| Cloud → Robot | `aimeecloud/device/<id>/status` | Status updates |
| Cloud → Robot | `aimeecloud/device/<id>/system` | Operational messages |

### Message Types (Inbound)
- `connect` — Creates or resumes a session. May include `api_key`, `capabilities`, `request_session_id`.
- `intent` — Keyword-routed request (weather, news, robot movement, games, etc.).
- `AimeeAgent` — LLM-driven mode. Bypasses keyword router.
- `game_move` — Move for the active game.
- `ping` — Keepalive.
- `disconnect` — Marks session as disconnected.

### Response Sub-Types (Outbound)
- `chat_response` — General text/TTS reply.
- `robot_command` — Keyword-routed motor/arm/gripper command.
- `game_update` — Game state, text, TTS, voice, optional commands.
- `aimee_agent` — LLM reply with voice, voice_segments, and commands.
- `error` — Error with human-readable text/TTS.

### HTTP API Endpoints (Port 3080)
- `GET /api/engines` — List all registered game engines.
- `GET /api/engines/:name` — Get metadata for a specific engine.
- `POST /api/admin/engines/generate` — Queue on-demand engine generation (admin auth required).

### Session Lifecycle
- Sessions are stored in-memory (`Map`) and flushed to `/tmp/aimeecloud-sessions.json` every 15 seconds.
- TTL: 10 minutes after disconnect, or 20 minutes of idle inactivity.
- Sessions can be resumed via `request_session_id` on reconnect.
- The HTTP API maintains a **separate** in-memory session store; it does not share session state with the MQTT gateway.

### Tiered Access
- `free`: 2 concurrent sessions, 10 sessions/day, 5 API calls/minute. TTS mode defaults to `client`.
- `paid`: unlimited sessions and API calls. TTS mode defaults to `server`.
- API keys are validated against SQLite. Hardcoded fallback keys exist for testing (`ac_free_demo_12345`, `ac_paid_demo_67890`).

### Voice System
- `voiceRegistry.json` maps abstract personas (e.g., `aimee-default`, `narrator`, `character-dragon`) to provider-specific IDs.
- Priority chain: ElevenLabs (server) → Lemonfox (client) → gTTS (client fallback).
- When `tts_mode` is `server` and `ELEVENLABS_API_KEY` is set, the gateway may include `tts_audio` (base64 MP3) in responses.

### LLM Integration
- **Gateway & Game Agent:** `google/gemini-2.5-flash-lite` via OpenRouter.
- **HTTP API:** still uses `openrouter/google/gemini-1.5-flash` (older model).
- `callLLM()` is the simple fallback for keyword-unmatched `chat` intents.
- `callAimeeAgentLLM()` is the rich agent prompt used for `AimeeAgent` messages. It instructs the model to return JSON-in-markdown containing `reply`, `tts`, `voice`, `commands`, and optional `voice_segments`.
- The AimeeAgent handler includes several suppression heuristics to avoid noisy responses:
  - **Polite filler silence** — "thanks", "ok", "hmm", etc. are ignored.
  - **Welcome loop silence** — If the user says "thank you" after Aimee said "you're welcome", she stays silent.
  - **Short-confirmation silence** — "yes/no/yeah/nope" are ignored unless Aimee's previous message was a question.
  - **Negative sentiment detection** — Triggers a `sad` expression command.

### Game Engine Integration
- The gateway has **engine-specific paths** for `tic-tac-toe`, `yahtzee`, and `candyland` (handling custom move formats and board rendering).
- All other games fall through a **generic engine path** that supports async `makeMove` / `agentMove` and standard `buildResponse`.
- Commands returned by engines are filtered through `validateEngineCommands()`; if `engine.stationary` is true, motor and drive-to commands are stripped.
- When a player wins, the gateway auto-injects a `happy` expression command.

### Gateway Module Exports
The MQTT gateway exports several functions so the Game Creation Agent can integrate with it at runtime:

```js
module.exports = {
  registerGameEngine,
  unregisterGameEngine,
  loadEnginesFromDisk,
  resolveGameEngine,
  gameEngines,
  startGame,
  processGameMove,
  normalizeCapabilities,
  resolveVoice,
  callLLM,
  sessions
};
```

---

## 7. Database Schema (SQLite)

Tables are auto-created on first run by `aimeecloud-auth.js`:

- `users` — `id`, `email`, `google_id`, `created_at`
- `api_keys` — `id`, `user_id`, `key`, `label`, `tier`, `is_disabled`, `created_at`, `last_used_at`
- `usage_logs` — `id`, `api_key`, `action`, `timestamp`
- `invite_requests` — `id`, `email`, `status`, `created_at`
- `game_engines` — `id`, `name`, `display_name`, `source`, `file_path`, `stationary`, `capabilities_needed`, `description`, `rules_summary`, `created_at`, `generation_prompt`, `test_results`

Database path: `/workspace/aimeecloud.db` (overridable via `AIMEECLOUD_DB` env var).

---

## 8. Deployment Process

1. `deploy.sh` copies code, config, and HTML to runtime locations.
2. It updates Mosquitto and Nginx configuration.
3. It installs Node dependencies in `/workspace/`.
4. It restarts Mosquitto and Nginx via `systemctl`.
5. It kills and restarts the Node.js API and gateway processes with `nohup`.

**Runtime environment file:** `/workspace/.env.aimeecloud`

Expected variables:
```bash
ELEVENLABS_API_KEY=your_key
JWT_SECRET=your_random_secret
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
ADMIN_TOKEN=your_admin_token   # For protected admin endpoints
OPENROUTER_API_KEY=your_key    # Optional: used by game-creation-agent
```

---

## 9. Security Considerations

- **Credentials moved to environment variables:** OpenRouter API keys and demo fallback API keys are no longer hardcoded. Set `OPENROUTER_API_KEY`, `OPENROUTER_HTTP_API_KEY`, `AIMEE_DEMO_KEY_FREE`, and `AIMEE_DEMO_KEY_PAID` in `/workspace/.env.aimeecloud` (or your chosen `.env` file). Rotate before production.
- **JWT secret:** Falls back to a random ephemeral secret if `JWT_SECRET` is unset, invalidating all sessions on restart.
- **Rate limiting:** In-memory only (per IP for HTTP, per API key for MQTT). Not distributed across multiple server instances.
- **Admin endpoints:** Protected by `X-Admin-Token` header compared against `ADMIN_TOKEN` env var.
- **Cookies:** Session cookies use `HttpOnly; SameSite=Lax`. `Secure` flag is added only when `NODE_ENV=production`.
- **CORS:** HTTP API allows `https://aimeecloud.com` with credentials.
- **MQTT broker:** Currently configured to allow anonymous connections. This is acceptable for the current test environment but must be locked down for production.

---

## 10. Multi-Agent Development Protocol

This project uses an internal developer-coordination protocol over MQTT (separate from the robot protocol). Agents:

- **Aimee** — Project Manager
- **DOAgent** — Gateway Developer (this codebase)
- **ROSAgent** — Robotics Developer

Topics: `agents/{agent_id}/in/#`, `agents/broadcast/#`, `agents/registry/#`

Message types: `task_request`, `task_response`, `standup`, `blocker`, `query`, `code_review`, etc.

See `AGENT_COORDINATION_PROTOCOL.md` for full spec.

---

## 11. Common Tasks for Agents

**Add a new voice persona:**
1. Add entry to `voiceRegistry.json` with provider fallbacks.
2. Update the LLM system prompt in `aimeecloud-mqtt-gateway.js` (`callAimeeAgentLLM`) if the persona should be selectable by the agent.
3. Run `deploy.sh` or copy `voiceRegistry.json` to `/workspace/`.

**Add a new game (manual):**
1. Implement the engine in `/workspace/game-test/engines/<game>.js` conforming to the universal contract.
2. Restart the gateway or call `loadEnginesFromDisk()` via the module API.

**Add a new game (via Game Creation Agent):**
1. POST `/api/admin/engines/generate` with `{ game_name }` (admin only).
2. The agent validates appropriateness, designs the game, generates code, runs sandbox tests, saves to disk, and registers with the gateway.
3. The engine is persisted in the `game_engines` table and loaded automatically on gateway restart.
4. **Important:** Ensure `game-creation-agent/` is copied to `/workspace/` or run the gateway from the source directory, otherwise the require will fail at runtime.

**Change rate limits:**
1. Edit `tier-config.json`.
2. Copy to `/workspace/` or run `deploy.sh`.

**Restart services after code change:**
```bash
pkill -f "node aimeecloud-mqtt-gateway.js"
pkill -f "node aimeecloud-api-v3.js"
# Then run deploy.sh or start manually
```

---

## 12. External Documentation

| File | Purpose |
|------|---------|
| `AIMEECLOUD_PROTOCOL.md` | Robot MQTT protocol spec v1.3 (messages, topics, voice, system messages) |
| `AIMEECLOUD_CLIENT_SPEC.md` | ROS2 node product specification for robot firmware developers |
| `AGENT_COORDINATION_PROTOCOL.md` | Multi-agent dev coordination protocol |
| `PHYSICAL_EXPRESSIVENESS_SPEC.md` | Robot animation/gesture vocabulary |
| `CAPABILITY_AWARE_GAME_ENGINES_PLAN.md` | Game engine capability-aware design |
| `AIMEECLOUD_PROJECT_PLAN.md` | Demo day timeline and milestones |
| `docs/openapi-spec.yaml` | Public REST/OpenAPI specification |

---

*This file is intended for AI coding agents. Keep it accurate and update it whenever architecture, deployment, or security assumptions change.*
