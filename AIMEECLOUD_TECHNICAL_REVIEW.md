# AimeeCloud Technical Review

**Date:** 2026-04-16  
**Scope:** Cloud-to-robot conversational AI infrastructure, MQTT gateway, game engines, and robot protocol.  
**Sources:** This document synthesizes the live implementation with the [`AimeeCloud-Implementation-Guide`](../AimeeCloud-Implementation-Guide.md) and the [`AimeeCloud-Robot-Protocol-Spec`](../AimeeCloud-Robot-Protocol-Spec.md).

---

## 1. Executive Summary

AimeeCloud is an MQTT-based conversational AI backend for robot companions. It provides:

- **Real-time chat** routed through a keyword classifier or an LLM agent (`AimeeAgent`).
- **Stateful games** (tic-tac-toe, yahtzee, candyland) with capability-aware responses.
- **Robot command generation** (motors, arm, gripper, camera snapshots).
- **Session resumption** with local file persistence so restarts do not wipe active sessions.
- **Voice-directed TTS** — every outbound payload carries a `voice` object mapped through a registry.

The design is intentionally ephemeral: all user state lives in an in-memory `Map` keyed by `session_id`, with periodic disk snapshots for recovery. There is no global user database.

---

## 2. Architecture at a Glance

```
Robot / Browser
       |
       | MQTT over TCP (1883) or WSS (443 via nginx)
       v
+------------------+
|   Mosquitto      |  <-- TCP :1883 (robots), WS :9001 (browsers)
+------------------+
       |
       | Subscribes to aimeecloud/device/+/connect and aimeecloud/device/+/in
       v
+---------------------------+
|  aimeecloud-mqtt-gateway  |  <-- Node.js (runs from /workspace/)
|                           |      Session store, intent router,
|                           |      LLM caller (OpenRouter), game proxy
+---------------------------+
       |
       +----> OpenRouter AI (google/gemini-2.5-flash) over HTTPS
       |
       +----> Game engines loaded directly from /workspace/game-test/engines/
```

> **Deployment note:** The running gateway loads from `/workspace/aimeecloud-mqtt-gateway.js`, not from the deploy directory. Changes must be copied and the service restarted via `deploy.sh`.

---

## 3. Core Design Principles

| Principle | How it is implemented |
|-----------|----------------------|
| **No global user storage** | User data lives only in a `Map<string, Session>` in the Node.js process. |
| **Ephemeral sessions** | Sessions expire after 10 minutes disconnected or 20 minutes idle. |
| **Unified protocol** | Browser test client and physical robot send identical JSON over the same topics. |
| **Low latency** | All real-time traffic is MQTT push; no polling. |
| **Context-aware interruption** | `active_context` plus a `context_stack` allows games to be paused and resumed seamlessly. |

---

## 4. Communication Protocol

> *Detailed schemas and state diagrams are defined in the [`AimeeCloud-Robot-Protocol-Spec`](../AimeeCloud-Robot-Protocol-Spec.md).*

### 4.1 Topic Structure

| Direction | Topic | Purpose |
|-----------|-------|---------|
| Robot → Cloud | `aimeecloud/device/{id}/connect` | Session init / resume |
| Robot → Cloud | `aimeecloud/device/{id}/in` | Intents, game moves, pings, agent requests, snapshot responses |
| Cloud → Robot | `aimeecloud/device/{id}/out` | All responses (chat, game updates, commands) |
| Cloud → Robot | `aimeecloud/device/{id}/status` | Session lifecycle events |
| Cloud → Robot | `aimeecloud/device/{id}/system` | Operational messages (config, diagnostics, firmware) |

### 4.2 Key Message Types

- **`connect`** — Creates or resumes a session. The robot advertises `capabilities` (input / output arrays) so the cloud can tailor responses.
- **`intent`** — Keyword-classified request. If the robot omits the `intent` object, the gateway classifies the `payload` text locally.
- **`AimeeAgent`** — Bypasses the keyword router and sends the request directly to the LLM. The LLM returns a JSON block containing `reply`, `tts`, `voice`, and optional `commands` (e.g., `snapshot`, `motor`, `game_move`).
- **`game_move`** — Sends a move to the active game engine.
- **`ping` / `pong`** — Keepalive.
- **`snapshot_response`** — Robot returns a captured image (Base64 JPEG) after receiving a `snapshot_request` or an inline `snapshot` command.

---

## 5. Session Lifecycle & Resiliency

### 5.1 Session Object

```js
{
  session_id: "sess_...",
  device_id: "arduino-uno-q-001",
  user_profile: { ... },
  capabilities: { input: [...], output: [...] },
  game_flags: { voice, display, snapshot, arm, platform },
  active_context: null | "Game: tic-tac-toe",
  context_stack: [],
  state_data: { "tic-tac-toe": { ... } },
  voice_persona: "aimee-default",
  last_reply: "...",
  last_reply_had_question: true | false,
  last_snapshot_sent_at: null | <timestamp>,
  created_at: <timestamp>,
  last_activity: <timestamp>,
  status: "connected" | "disconnected"
}
```

### 5.2 TTL Behavior

| Event | Behavior |
|-------|----------|
| **Connect (new)** | Fresh session created; `session_id` returned in `session_init`. |
| **Connect (resume)** | If `request_session_id` matches an existing session for the same device, state is restored. |
| **Disconnect** | Status becomes `disconnected`; 10-minute TTL begins. |
| **Reconnect within TTL** | Full state (games, chat context, voice persona) is preserved. |
| **TTL expiry** | Session purged from memory and disk. |

### 5.3 Session Persistence

The gateway writes the entire `sessions` Map to `/tmp/aimeecloud-sessions.json` every 15 seconds and on every lifecycle event (connect, disconnect, game start). On startup, it loads the file. This means:

- A gateway restart does **not** wipe sessions.
- Robots that were connected before the restart can resume seamlessly on their next ping or reconnect.

> *See [`AimeeCloud-Implementation-Guide`](../AimeeCloud-Implementation-Guide.md) §5 for the original ephemeral design; persistence was added later to bridge restarts.*

---

## 6. Routing & Intent Handling

### 6.1 Keyword Classifier

The gateway runs a lightweight keyword classifier (ported from the legacy REST API). Intents include:

| Category | Examples |
|----------|----------|
| `robot_control` | `robot_forward`, `robot_backward`, `robot_stop`, `robot_left`, `robot_right`, `robot_wave` |
| `arm_control` | `arm_raise`, `arm_lower` |
| `gripper_control` | `gripper_open`, `gripper_close` |
| `cloud_skill` | `weather`, `news`, `story`, `game`, `help`, `status`, `chat` |

If no keyword matches, the intent falls back to `chat`.

### 6.2 AimeeAgent LLM Mode

`AimeeAgent` is the preferred path for natural-language interaction. The gateway calls **OpenRouter** (`google/gemini-2.5-flash`) with a system prompt that instructs the model to:

- Return structured JSON with `reply`, `tts`, `voice`, `commands`, and optional `voice_segments`.
- Stay silent (`silent: true`) for random words, fragments, or background noise.
- **Exception:** Answer `yes` / `no` **only if** the previous Aimee reply ended with a question mark.
- Include a `snapshot` command when the user asks for a photo, and describe the scene in a warm, positive way.
- Issue `game_move` commands when a game is active and the user describes a move.

### 6.3 Context Stacking (Interruptions)

When a user is in a game and sends a non-game intent (e.g., `weather`), the gateway:

1. Pushes `active_context` onto `context_stack`.
2. Processes the new intent normally.
3. Appends a resume hint to the TTS (e.g., `"Back to Tic-Tac-Toe, your move!"`).
4. Restores the game context automatically on the next game-related message.

> *Full interruption semantics are documented in the [`AimeeCloud-Robot-Protocol-Spec`](../AimeeCloud-Robot-Protocol-Spec.md) §8.*

---

## 7. Game Engine Integration

### 7.1 Capability-Aware Modes

Each game engine selects a mode based on the robot's normalized capability flags:

| Mode | Requirements | Behavior |
|------|--------------|----------|
| `voice+snapshot` | `voice` + `snapshot` | Spoken updates + `snapshot` command after each board-changing move. |
| `voice-only` | `voice` | Purely spoken updates; no camera commands. |
| `display-only` | `display` | Text/graphics only fallback. |

### 7.2 Engines

- **Tic-Tac-Toe** (`/workspace/game-test/engines/tictactoe.js`) — Minimax AI, natural-language move parsing (e.g., `"center"` → `4`), `buildResponse` returns `commands`.
- **Yahtzee** — Dice holding, re-rolling, and scoring with mode-aware snapshot commands.
- **Candyland** — Board movement with similar capability fallback.

### 7.3 Snapshot Stall Fallback

If the robot has `snapshot` capability but the camera pipeline stalls (no response within ~15 seconds), the gateway:

1. Detects the stall on the next game move check.
2. Automatically downgrades the game mode to `voice-only`.
3. Tells the user: *"It looks like the snapshot isn't coming through. Let's switch to voice only so we can keep playing."*

This prevents a broken camera from blocking gameplay indefinitely.

---

## 8. Voice & TTS

### 8.1 Voice Registry

`voiceRegistry.json` maps abstract personas to concrete provider voice IDs (Lemonfox primary, gTTS fallback):

| Persona | ID | Use Case |
|---------|----|----------|
| `aimee-default` | `sarah` | Normal conversation |
| `aimee-surprised` | `jessica` | Expressive reactions |
| `aimee-calm` | `echo` | Errors / reassurance |
| `narrator` | `liam` | Storytelling |
| `character-dragon` | `onyx` | Dramatic characters |
| `game-announcer` | `echo` | Neutral game updates |

### 8.2 Session Voice Consistency

The gateway tracks `voice_persona` on each session. Once a user is interacting in a particular voice (e.g., `aimee-default`), game updates preserve that voice instead of force-switching to `game-announcer`.

### 8.3 Voice Segments

For multi-character storytelling, `AimeeAgent` may return `voice_segments` — an ordered array of `{ speaker, text, voice }` objects. The robot synthesizes them sequentially.

---

## 9. Snapshot Service

### 9.1 Inline Snapshot Commands

Game engines and `AimeeAgent` can emit a `snapshot` command directly inside the `commands` array of a normal response:

```json
{
  "type": "response",
  "sub_type": "game_update",
  "commands": [
    { "type": "snapshot", "camera": "front", "purpose": "show_board" }
  ],
  "tts": "Let me see what you just did."
}
```

### 9.2 Robot Workflow

> *The canonical robot-side workflow is defined in the [`AimeeCloud-Robot-Protocol-Spec`](../AimeeCloud-Robot-Protocol-Spec.md) §7.*

In short:
1. Pause `usb_camera`.
2. Capture snapshot via ROS2 service `/camera/capture_snapshot`.
3. Return Base64 JPEG in a `snapshot_response` on `…/in`.
4. **Restart `usb_camera`.**

---

## 10. File Locations & Key Artifacts

| File | Purpose |
|------|---------|
| `/workspace/aimeecloud-mqtt-gateway.js` | **Main runtime** — session store, router, LLM caller, game proxy. |
| `/workspace/game-test/engines/tictactoe.js` | Tic-tac-toe engine (capability-aware). |
| `/workspace/game-test/engines/yahtzee.js` | Yahtzee engine. |
| `/workspace/game-test/engines/candyland.js` | Candyland engine. |
| `/home/scott/aimeecloud-deploy/voiceRegistry.json` | Persona → voice ID mapping. |
| `/home/scott/aimeecloud-deploy/deploy.sh` | Deployment script — copies to `/workspace/` and restarts services. |
| `/var/log/aimeecloud-mqtt-gateway.log` | Runtime logs (full MQTT payloads). |
| `/tmp/aimeecloud-sessions.json` | Session persistence file. |
| `/var/www/html/aimeecloud/aimee/index.html` | Browser test client (1:1 robot substitute). |
| [`AimeeCloud-Implementation-Guide`](../AimeeCloud-Implementation-Guide.md) | Original architecture, component, and deployment guide. |
| [`AimeeCloud-Robot-Protocol-Spec`](../AimeeCloud-Robot-Protocol-Spec.md) | Complete message schemas and robot firmware contract. |
| `AIMEECLOUD_PROTOCOL.md` | Protocol summary published as a retained MQTT message. |
| `CAPABILITY_AWARE_GAME_ENGINES_PLAN.md` | Design plan for the capability-aware refactor. |

---

## 11. Deployment & Operations

### 11.1 Deploy

```bash
cd /home/scott/aimeecloud-deploy
sudo bash deploy.sh
```

This script:
1. Copies the gateway to `/workspace/`.
2. Copies the browser client to `/var/www/html/aimeecloud/aimee/`.
3. Restarts Mosquitto and reloads Nginx.
4. Restarts the Node.js gateway process.

### 11.2 View Logs

```bash
sudo tail -f /var/log/aimeecloud-mqtt-gateway.log
```

### 11.3 Restart Gateway Only

```bash
sudo pkill -f 'aimeecloud-mqtt-gateway.js'
sudo bash -c 'cd /workspace && nohup node aimeecloud-mqtt-gateway.js >> /var/log/aimeecloud-mqtt-gateway.log 2>&1 &'
```

---

## 12. Recent Notable Changes

| Feature | Description |
|---------|-------------|
| **AimeeAgent routing** | LLM can return robot `commands` inline; auto-starts games and auto-processes `game_move` commands. |
| **Voice registry** | All outbound responses carry a resolved `voice` object. |
| **Session persistence** | `/tmp/aimeecloud-sessions.json` saves/restores sessions across gateway restarts. |
| **Capability-aware games** | Tic-tac-toe, yahtzee, and candyland adapt to `voice+snapshot` / `voice-only` / `display-only`. |
| **Snapshot stall fallback** | Games automatically downgrade to `voice-only` if snapshots stop returning. |
| **Yes/No context guard** | Short confirmations are only answered when Aimee actually asked a question. |
| **Conversational snapshot TTS** | Snapshot delays are hidden behind natural phrases like *"Let me see what you just did."* |

---

*This document is intended for technical review and onboarding. For robot firmware implementation details, refer to the [`AimeeCloud-Robot-Protocol-Spec`](../AimeeCloud-Robot-Protocol-Spec.md). For operational deployment procedures, refer to the [`AimeeCloud-Implementation-Guide`](../AimeeCloud-Implementation-Guide.md).*
