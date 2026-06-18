# Task: Create Public API Documentation (OpenAPI Spec)

## Context

AimeeCloud needs a public API spec for robot manufacturers to integrate with. This is essential for the investor pitch and B2B sales.

## What To Create

Create `/home/scott/aimeecloud-deploy/docs/openapi-spec.yaml` — an OpenAPI 3.0 spec covering:

### 1. MQTT Protocol Endpoints
Define the topic-based API (using OpenAPI spec for MQTT is non-standard, so document as WebSocket-like async API):

**Connection**
- `POST /connect` — Initialize session with robot capabilities
- `GET /status` — Connection status
- `DELETE /disconnect` — End session

**Messaging**
- `POST /in` — Send intent, game_move, AimeeAgent requests
- `WebSocket /out` — Receive responses (session_init, response, game_update, robot_command, etc.)

### 2. REST Endpoints (Optional, for browser clients)
- `GET /health` — Health check
- `GET /session/{id}` — Session info

### 3. Message Types
Document all the JSON message types from `AIMEECLOUD_PROTOCOL.md`:
- connect
- disconnect  
- intent
- game_move
- AimeeAgent
- snapshot_request / snapshot_response
- Session init, responses, errors

### 4. Capability Declaration
Document the standard capability fields robots can declare:
- `voice` — Has TTS
- `display` — Has screen
- `snapshot` — Has camera
- `arm` — Has robotic arm
- `platform` — Can move/drive
- `led` — Has LED expressions

### 5. Authentication
- Per-robot API key via `X-API-Key` header
- Token validation on connect

## Reference Files
- `/home/scott/aimeecloud-deploy/AIMEECLOUD_PROTOCOL.md` — Existing protocol
- `/home/scott/aimeecloud-deploy/AIMEECLOUD_CLIENT_SPEC.md` — ROS2 client spec

## Output
Create valid OpenAPI 3.0 YAML at `/home/scott/aimeecloud-deploy/docs/openapi-spec.yaml`

## Constraints
- Do NOT modify existing files
- Create only the new spec file
- Make it complete enough for a developer to understand the API
