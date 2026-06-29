# Vision/Action Enhancement Plan (Hybrid)

## Goal

Use AimeeCloud for **high-level vision and planning** (object detection, board-state parsing, move validation) while the robot keeps **robot-specific calibration and final visual servoing** local. This reduces latency for delicate pick/place moves and keeps the camera-to-arm transform with the hardware that owns it.

Robot responsibilities:

1. Store its own calibration profile (camera intrinsics, look/board pose, pixel→cartesian scale/offset).
2. Move to named poses (`HOME`, `LOOK`, `BOARD`) or cartesian targets.
3. Capture and upload frames (single snapshot or stream).
4. Convert cloud-returned **pixel targets** into coarse cartesian moves using local calibration.
5. Perform final fine adjustment using the local camera stream and onboard CV.
6. Execute gripper commands and verify the result via camera.

AimeeCloud responsibilities:

1. Accept frames and return structured vision results (object labels, bounding boxes, pixel centers, board state, changed cells).
2. Run game engines and convert moves into pixel targets or board notation.
3. Issue high-level skills (`pick_object`, `place_object`, `scan_board`, `watch_for_move`).

This enables:

- **Open-vocabulary pick/place:** User says *"pick up the red dice"* → cloud detects object and returns its pixel center in the current LOOK frame → robot converts to cartesian, approaches, and locally fine-tunes before grasping.
- **Vision-assisted game play:** Game engine watches frames for changes, validates the opponent's move, and directs the robot's move (e.g., `E2→E4` → cloud resolves target board cell → robot maps cell to pixel → cartesian → place piece).

---

## Current State

- `take_snapshot` in `function-router.js` sends a frame to a vision LLM and returns a text description.
- Robot commands (`motor_command`, `arm_command`, `gripper_command`, `set_expression`) are one-shot MQTT responses.
- Game engines (`engines/tictactoe.js`, etc.) return text/tts and a small `commands` array (e.g., `snapshot`).
- No cloud-side structured object detector, no streaming protocol, and no multi-step skill sequencer.

---

## High-Level Architecture

```
User / Game Engine
        │
        ▼
┌─────────────────────┐
│  AimeeCloud API     │  (intent_router / function-router / game engine)
│  + Skill Sequencer  │
└──────────┬──────────┘
           │ 1. skill: pick_object("red dice")
           ▼
┌─────────────────────┐
│  Vision Service     │  (cloud-side object/board detection)
│  - LLM vision (MVP) │
│  - YOLO/CLIP/SAM    │
└──────────┬──────────┘
           │ 2. pixel target(s) + labels + board state
           ▼
        Robot
           │ 3. pixel → cartesian (local calibration)
           ▼
┌─────────────────────┐
│  Local CV + Arm     │  (coarse move → reacquire → fine-tune → grasp)
└─────────────────────┘
```

---

## New / Modified Components

### 1. Vision Service (`services/vision/`)

Responsibilities:
- Accept a snapshot image or streamed frame.
- Return structured results:
  - `objects`: array of `{ label, confidence, bbox: {x1,y1,x2,y2}, center: {x,y} }`
  - `board_state`: for games (e.g., tic-tac-toe cell occupancy, chess piece positions)
  - `changes`: changed cells/regions between two frames

Suggested implementation path:
- **MVP:** Use the existing vision LLM (OpenRouter/Gemini) with a JSON-output prompt. Cheap to prototype, slower (~1–3s).
- **Production:** Add a local YOLOv8 / Segment Anything / CLIP pipeline for faster detection.

### 2. Robot-Side Calibration Profile

Keep the calibration profile on the robot (ROS params, local JSON, or firmware config) so AimeeCloud only deals with pixels.

Example profile:

```json
{
  "device_id": "Aimee",
  "camera": {
    "resolution": [640, 480],
    "center": [320, 240]
  },
  "poses": {
    "home": { "joints": [2056, 2060, 2636, 2484, 2043, 2062] },
    "look": { "x": 0.250, "y": 0.000, "z": 0.100, "pitch": 1.571 }
  },
  "pixel_to_cartesian": {
    "look": {
      "scale_u": 0.0008,
      "scale_v": 0.0008,
      "offset_x": 0.0125,
      "offset_y": 0.0
    }
  }
}
```

The robot exposes a helper:

```python
def pixel_to_cartesian(pose_name, u, v):
    cal = calibration[pose_name]
    du = u - camera_center_u
    dv = v - camera_center_v
    dx = dv * cal.scale_v
    dy = -du * cal.scale_u
    pose = poses[pose_name]
    return {
        "x": pose.x + dx + cal.offset_x,
        "y": pose.y + dy + cal.offset_y,
        "z": pose.z,
        "pitch": pose.pitch
    }
```

AimeeCloud can optionally request the robot send the calibration profile on connect so the cloud can show approximate real-world coordinates in logs/UIs, but the robot remains the source of truth.

### 3. Hybrid Pick/Place Skill Flow

#### Coarse planning (cloud)

1. User says *"pick up the red dice"*.
2. Cloud sequencer sends `arm_waypoint` to `LOOK` pose.
3. Robot sends `command_complete`.
4. Cloud requests snapshot with `analysis: object_detection`, `query: "red dice"`.
5. Vision returns `center: {x: 420, y: 180}`.
6. Cloud sends `target_pixel` command:
   ```json
   {
     "type": "target_pixel",
     "pose": "look",
     "u": 420,
     "v": 180,
     "mode": "coarse",
     "purpose": "pick_red_dice"
   }
   ```

#### Fine execution (robot)

7. Robot converts pixel to cartesian using local calibration.
8. Robot moves above target (`safe_z`).
9. Robot captures a local frame, re-detects the object (local CV), computes remaining pixel error.
10. Robot sends small correction moves until the object is centered under the gripper tip.
11. Robot lowers, grips, lifts, and sends `command_complete`.
12. Cloud may request a verification snapshot to confirm the object is in the gripper.

This same flow works for place operations: cloud returns the target cell/pixel, robot does coarse move + local fine-tune.

### 4. Game Engine Integration (Vision Mode)

For each game engine, add a vision-mode path:

1. **Baseline frame:** Move to `BOARD` pose, capture frame, scan board state.
2. **Watch for opponent move:** Capture new frame after opponent plays, diff against baseline.
3. **Validate:** Engine checks that the detected move matches rules.
4. **Robot move:** Engine outputs target in game notation; cloud resolves it to a board cell pixel using a per-cell calibration map; robot maps pixel → cartesian and places/picks the piece.

Example cell map on the robot:

```json
{
  "board_cells": {
    "tic_tac_toe": {
      "center": {"u": 320, "v": 240},
      "top_left": {"u": 220, "v": 140},
      ...
    }
  }
}
```

The cloud can also just return the cell name (e.g., `"center"`) and let the robot resolve it locally, which is simpler and keeps cell geometry with the robot.

### 5. Frame Streaming Protocol

Add video streaming to the audio-native WebSocket (or a separate `/ws/vision` endpoint). Messages:

**Cloud → Robot:**

```json
{ "type": "video_stream_start", "resolution": [640,480], "fps": 5, "purpose": "object_tracking" }
{ "type": "video_stream_stop" }
```

**Robot → Cloud:**

```json
{ "type": "video_chunk", "format": "jpeg", "timestamp": "...", "frame_id": "..." }
```

Plus the binary JPEG payload (sent as a separate WS binary frame or base64 in JSON for MQTT).

Use cases:
- Continuous monitoring while the arm moves.
- Cloud-based board-state tracking without repeated snapshot requests.
- Future cloud-side visual servoing if latency is acceptable.

For the hybrid plan, streaming is optional for most operations; single snapshots are enough for object detection and board-state diffing.

### 6. Audio-Native Function Declarations

Add to `function-router.js`:

- `detect_objects(query, pose)` → returns detected object centers/pixels.
- `pick_object(query, pose)` → runs full cloud-coordinated pick skill.
- `place_object(target_cell_or_pixel, pose)` → runs place skill.
- `scan_board_state(game, pose)` → returns board state.
- `watch_for_move(game, pose)` → captures baseline and new frame, returns changed cells.

### 7. New Robot Command Types

Extend `robot_command` responses with:

- `arm_cartesian` — direct x,y,z,pitch,gripper move.
- `arm_waypoint` — named pose (`home`, `look`, `board`).
- `gripper` — gripper width + time.
- `target_pixel` — cloud gives pixel target, robot converts and executes locally.
- `snapshot` — request a frame with a tag/purpose.
- `start_video_stream` / `stop_video_stream` — enable/disable frame streaming.

---

## Protocol Additions

### Snapshot request with analysis type

```json
{
  "type": "take_snapshot",
  "camera": "front",
  "purpose": "detect_red_dice",
  "analysis": "object_detection",
  "query": "red dice"
}
```

### Vision result

```json
{
  "type": "vision_result",
  "purpose": "detect_red_dice",
  "objects": [
    { "label": "red dice", "confidence": 0.94, "center": {"u": 420, "v": 180} }
  ]
}
```

### Target pixel command

```json
{
  "type": "response",
  "sub_type": "robot_command",
  "commands": [
    {
      "type": "target_pixel",
      "pose": "look",
      "u": 420,
      "v": 180,
      "mode": "coarse",
      "purpose": "pick_red_dice"
    }
  ]
}
```

### Robot progress message

Robot publishes on `system/in`:

```json
{
  "type": "command_complete",
  "device_id": "Aimee",
  "session_id": "sess_...",
  "command_id": "cmd_...",
  "status": "ok",
  "timestamp": "..."
}
```

### Video streaming messages

See Section 5 above.

---

## Suggested Implementation Phases

### Phase 1 — Cartesian/Waypoint Commands + Robot Progress (1–2 days)
- Add `arm_cartesian`, `arm_waypoint`, `gripper` command types to `function-router.js`.
- Add `command_complete` handling to the MQTT gateway so the sequencer can wait.
- Robot executes a simple cloud-driven sequence: `LOOK` → cartesian move → `HOME`.

### Phase 2 — Cloud Object Detection + Target Pixel (2–3 days)
- Add `detect_objects(query)` and `pick_object(query)` functions.
- Vision service returns pixel centers via LLM vision JSON prompt.
- Cloud sends `target_pixel` command; robot uses local calibration for coarse move.
- Validate with the red dice test (coarse only at first).

### Phase 3 — Local Fine-Tune / Visual Servoing (2–3 days)
- Robot re-captures frame after coarse move.
- Local CV re-detects object and computes correction.
- Robot sends small correction moves until centered.
- Add verification snapshot after grasp.

### Phase 4 — Game Board Vision (2–3 days)
- Add `scan_board_state(game)` and `watch_for_move(game)`.
- Update game engines to accept vision-mode moves.
- Robot stores cell-to-pixel map and resolves `center`, `top_left`, etc. locally.

### Phase 5 — Frame Streaming + Production Vision (1–2 weeks)
- Add `video_stream_start/stop` and `video_chunk` to the WebSocket protocol.
- Replace LLM vision with local YOLO/SAM/CLIP for lower latency.
- Add cloud-based monitoring UI using the stream.

---

## Open Questions

1. **Calibration tooling:** Do you want a simple robot-side calibration routine (move gripper to known points, record pixels) or manual JSON editing?
2. **Frame transport:** Use the existing audio WebSocket for video chunks, or a separate `/ws/vision` endpoint?
3. **Local CV library:** What is available on the robot? OpenCV, YOLO, ROS2 image pipeline, etc.?
4. **Verification confidence:** Should the cloud make the final "object picked" decision from a verification frame, or is local camera verification sufficient?
5. **Multi-object scenes:** If the user says *"pick up the red dice* and there are two, should the cloud pick the closest/most central, or ask for clarification?

---

## Files Likely to Change

- `aimeecloud-deploy/function-router.js` — new functions and command types
- `aimeecloud-deploy/aimeecloud-mqtt-gateway.js` — sequencer integration, command progress handling
- `aimeecloud-deploy/aimeecloud-audio-gateway.js` — expose new functions to audio-native LLM, video stream messages
- `aimeecloud-deploy/engines/*.js` — vision-mode move handling
- `aimeecloud-deploy/services/vision.js` (new) — detection/analysis service
- `aimeecloud-deploy/services/skills.js` (new) — skill sequencer
- `AimeeCloud-Robot-Protocol-Spec.md` — new command types, target_pixel, video streaming, progress messages

---

## Next Step Recommendation

Start with **Phase 1**: add `arm_cartesian`, `arm_waypoint`, `gripper` commands and `command_complete` progress messages. Once the robot can be driven through a cloud-generated sequence, add `detect_objects` and `target_pixel` for the red-dice test.
