# AimeeCloudClient ROS2 Node — Product Specification

## The Product Boundary

AimeeCloudClient is the **single integration point** between any robot and AimeeCloud. It defines a clean contract:

```
YOUR ROBOT                          │  AIMEECLOUD
                                    │
  Your STT node ──→ /cloud/speak ──→│──→ AimeeCloud Gateway
  Your motor node ←── /cmd_vel ←────│←── Game engines, LLM, TTS
  Your arm node ←── /arm/command ←──│←── Agent workflows
  Your camera ──→ /cloud/snapshot ──│──→ Vision analysis
                                    │
         AimeeCloudClient Node      │
```

**Everything to the left** is the robot developer's responsibility.  
**Everything to the right** is AimeeCloud's responsibility.  
**The node itself** is the bridge — and it's what we ship.

---

## Why This Matters (Business Case)

1. **Instant value** — Drop one ROS2 node into your workspace, set your API key, and your robot talks, plays games, teaches lessons.
2. **Testing tool** — Developers can test their robot's capabilities against AimeeCloud without building their own AI stack.
3. **Clear upgrade path** — Free tier for testing → paid tier for production.
4. **Distribution channel** — Every AimeeCloudClient install is a potential paying customer.

---

## ROS2 Interface Contract

### What AimeeCloudClient SUBSCRIBES To (Your Robot Publishes These)

| Topic | Message Type | Purpose | Required? |
|-------|-------------|---------|-----------|
| `/cloud/speak` | `std_msgs/String` | Raw text from your STT — sent to AimeeCloud for processing | **Yes** |
| `/cloud/game_move` | `std_msgs/String` | JSON game move (e.g., `{"game":"tic-tac-toe","position":4}`) | Optional |
| `/cloud/snapshot_response` | `std_msgs/String` | JSON with `image_base64` when cloud requests a photo | Optional |
| `/cloud/capabilities_update` | `std_msgs/String` | JSON capabilities update if hardware changes at runtime | Optional |

### What AimeeCloudClient PUBLISHES (Your Robot Subscribes to These)

| Topic | Message Type | Purpose | Always Published? |
|-------|-------------|---------|-------------------|
| `/cloud/tts` | `std_msgs/String` | Text for your TTS engine to speak (with optional `provider\|voice:` prefix) | **Yes** |
| `/cloud/tts_segments` | `std_msgs/String` | JSON array of voice segments for multi-character speech | When applicable |
| `/cloud/motor_command` | `geometry_msgs/Twist` | Movement commands from cloud (forward, turn, stop) | When applicable |
| `/cloud/arm_command` | `std_msgs/String` | JSON arm action (e.g., `{"action":"raise"}`, `{"action":"lower"}`) | When applicable |
| `/cloud/snapshot_request` | `std_msgs/String` | JSON request for your robot to capture and return a photo | When applicable |
| `/cloud/game_state` | `std_msgs/String` | JSON game state updates | When applicable |
| `/cloud/expression` | `std_msgs/String` | JSON expression command (e.g., `{"type":"happy"}`, `{"type":"thinking"}`) | When applicable |
| `/cloud/connected` | `std_msgs/Bool` | Whether currently connected to AimeeCloud | **Yes** |
| `/cloud/session_id` | `std_msgs/String` | Current session ID | **Yes** |

### Services AimeeCloudClient PROVIDES

| Service | Type | Purpose |
|---------|------|---------|
| `/cloud/send_text` | `std_srvs/srv/SetBool` (or custom) | Manually send text to cloud (for non-STT input) |
| `/cloud/clear_session` | `std_srvs/srv/Trigger` | Force-clear session and reconnect |
| `/cloud/get_status` | `std_srvs/srv/Trigger` | Return connection status, session info |

---

## Configuration (YAML)

```yaml
aimee_cloud_client:
  ros__parameters:
    # === REQUIRED ===
    api_key: "your-api-key-here"        # From aimeecloud.com/dashboard
    device_id: "my-robot-001"           # Unique ID for this robot

    # === CONNECTION ===
    broker_host: "aimeecloud.com"       # Default cloud broker
    broker_port: 443                     # WSS port
    use_websocket: true                  # true for WSS, false for raw MQTT
    websocket_path: "/aimeecloud-mqtt"

    # === ROBOT IDENTITY ===
    robot_name: "My Robot"               # Display name
    robot_location: "home"               # Location hint for cloud context

    # === CAPABILITIES (What your robot can do) ===
    # These tell AimeeCloud how to tailor responses.
    # The cloud uses these to select game modes, lesson formats, etc.
    cap_voice: true          # Robot can speak (TTS available)
    cap_display: false       # Robot has a screen
    cap_snapshot: true       # Robot has a camera that can capture photos
    cap_arm: false           # Robot has an articulated arm
    cap_platform: true       # Robot can drive/move
    cap_led: false           # Robot has LED expressions

    # === AUDIO STREAMING (Optional) ===
    audio_streaming: false   # Use native audio WebSocket instead of text-based voice
    audio_provider: "gemini" # "gemini" or "openai"

    # === ADVANCED ===
    reconnect_interval_sec: 5.0
    ping_interval_sec: 60.0
    session_file: "~/.aimeecloud/session.json"
    tts_format: "text"       # "text" (plain) or "tagged" (provider|voice:text)
```

---

## Minimal Integration Example

### Step 1: Install

```bash
# From PyPI (future)
pip install aimeecloud-ros2-client

# Or clone into your workspace
cd ~/your_ws/src
git clone https://github.com/aimeecloud/aimeecloud-ros2-client.git
cd ~/your_ws && colcon build --packages-select aimeecloud_client
```

### Step 2: Configure

```yaml
# config/aimeecloud.yaml
aimee_cloud_client:
  ros__parameters:
    api_key: "ac_free_abc123"
    device_id: "my-first-robot"
    cap_voice: true
    cap_platform: true
```

### Step 3: Launch

```bash
ros2 run aimeecloud_client aimee_cloud_client --ros-args \
  --params-file config/aimeecloud.yaml
```

### Step 4: Connect Your STT

```python
# In your STT node, when you get a transcription:
from std_msgs.msg import String

# Publish transcribed text — AimeeCloudClient handles the rest
self.cloud_pub = self.create_publisher(String, '/cloud/speak', 10)
self.cloud_pub.publish(String(data="What's the weather like?"))
```

### Step 5: Connect Your TTS

```python
# In your TTS node, subscribe to cloud responses:
self.create_subscription(String, '/cloud/tts', self.on_cloud_tts, 10)

def on_cloud_tts(self, msg):
    self.speak(msg.data)  # Your TTS implementation
```

### Step 6: (Optional) Connect Your Motors

```python
# Subscribe to movement commands from cloud:
self.create_subscription(Twist, '/cloud/motor_command', self.on_motor, 10)

def on_motor(self, msg):
    # Forward to your motor controller
    self.cmd_vel_pub.publish(msg)
```

That's it. Your robot now has:
- Natural conversation via AimeeCloud LLM
- Access to games (tic-tac-toe, yahtzee, candyland, and AI-generated games)
- Educational content
- Expressiveness commands (if your robot supports them)

---

## Capability Testing Mode

A key use case: developers testing their robot's capabilities as they build.

```bash
# Launch in test mode — cloud sends test commands for each capability
ros2 run aimeecloud_client aimee_cloud_client --ros-args \
  -p api_key:="ac_free_abc123" \
  -p device_id:="test-robot" \
  -p test_mode:=true
```

In test mode, AimeeCloudClient will:
1. Connect to cloud
2. Request a capability test sequence
3. Cloud sends commands one by one: "Say hello" → "Move forward" → "Take a photo" → "Wave your arm"
4. Report which commands your robot handled vs. which timed out
5. Generate a capability report

This lets developers verify their integration incrementally — "My TTS works, my motors respond, but my camera isn't returning snapshots yet."

---

## Architecture: How It Differs From Our Internal Cloud Bridge

| Feature | Internal `aimee_cloud_bridge` | Distributable `aimeecloud_client` |
|---------|-------------------------------|-----------------------------------|
| Message types | Uses custom `aimee_msgs` | Uses only `std_msgs` + `geometry_msgs` (zero custom deps) |
| Snapshot handling | Calls internal `CaptureSnapshot` service, stops/starts usb_cam | Publishes request on `/cloud/snapshot_request`, robot handles capture |
| Motor commands | Publishes directly to `/cmd_vel` | Publishes to `/cloud/motor_command` (robot remaps) |
| Arm commands | Uses custom `ArmCommand` msg | Publishes JSON on `/cloud/arm_command` |
| Configuration | Hardcoded paths, internal session file | Configurable via YAML, follows XDG paths |
| Capabilities | Hardcoded in source | Declared via YAML params, updatable at runtime |
| Authentication | None (trusted network) | API key required |
| Dependencies | `aimee_msgs`, `paho-mqtt` | `paho-mqtt` only (plus standard ROS2) |

**Key design decision:** The distributable client uses ONLY standard ROS2 message types (`std_msgs/String`, `geometry_msgs/Twist`, `std_msgs/Bool`). This means zero custom message dependencies — any ROS2 project can use it immediately without building `aimee_msgs`.

---

## Native Audio Streaming (Optional)

Robots that support real-time conversational audio can enable `audio_streaming: true`. Instead of sending text intents and receiving TTS text, the client opens a WebSocket to `wss://aimeecloud.com/ws/v1` and streams raw audio (Opus or PCM16) bidirectionally.

When audio streaming is enabled:
- `/cloud/speak` is not used for voice input (audio goes over WebSocket)
- `/cloud/tts` is not used for voice output (audio comes over WebSocket)
- Motor, arm, gripper, snapshot, and expression commands still arrive on their normal MQTT/ROS2 topics

```yaml
aimee_cloud_client:
  ros__parameters:
    audio_streaming: true
    audio_provider: "gemini"   # or "openai"
    audio_in_codec: "pcm16"    # "opus" requires @discordjs/opus
    audio_in_sample_rate: 16000
    audio_out_sample_rate: 24000
```

## Migration Path: Internal → Distributable

Our internal `aimee_cloud_bridge` on the UNO Q will eventually become a thin wrapper around `aimeecloud_client`:

```
Phase 1 (Now): aimee_cloud_bridge (internal, custom msgs)
Phase 2 (May): Build aimeecloud_client (standard msgs, distributable)
Phase 3 (June): Internal bridge wraps aimeecloud_client + remaps to aimee_msgs
Phase 4 (July): Both robots use aimeecloud_client under the hood
```

---

## Package Structure

```
aimeecloud_client/
├── aimeecloud_client/
│   ├── __init__.py
│   ├── cloud_client_node.py       # Main ROS2 node
│   ├── mqtt_bridge.py             # MQTT connection handling
│   ├── capability_negotiator.py   # Maps YAML caps → protocol caps
│   ├── command_dispatcher.py      # Routes cloud commands → ROS2 topics
│   └── test_mode.py               # Capability testing logic
├── config/
│   └── default.yaml               # Default configuration
├── launch/
│   └── client.launch.py           # Launch file
├── test/
│   ├── test_connection.py
│   ├── test_capabilities.py
│   └── test_game_flow.py
├── package.xml
├── setup.py
├── setup.cfg
├── README.md                      # Quick start guide
└── LICENSE                        # Apache 2.0 or MIT
```

---

## Success Criteria

| Criteria | Target |
|----------|--------|
| Zero custom message dependencies | Only std_msgs + geometry_msgs |
| Install to first cloud response | Under 5 minutes |
| Works on ROS2 Humble + Iron + Jazzy | Tested on all three |
| README is complete quick-start | Someone can integrate without asking us |
| Capability test mode works | Generates report of working/broken capabilities |
| PyPI installable (future) | `pip install aimeecloud-ros2-client` |

---

*Document Version: 0.1*  
*Created: April 17, 2026*
