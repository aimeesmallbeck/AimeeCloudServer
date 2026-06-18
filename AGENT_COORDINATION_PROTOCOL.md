# AimeeCloud Multi-Agent Development Coordination Protocol

**Version:** 1.0  
**Date:** 2026-04-17  
**Purpose:** Streamline collaborative development of AimeeCloud and the robot firmware by coordinating tasks among specialized developer agents.

---

## Agent Identities (Development Team)

| Agent ID | Role | What They Build |
|----------|------|-----------------|
| **Aimee** | Orchestrator / Project Manager | Defines requirements, assigns tasks, reviews deliverables, resolves blockers, keeps the project on track. Does not write code directly. |
| **DOAgent** | AimeeCloud Gateway Developer | Writes, deploys, and maintains the Node.js MQTT gateway (`aimeecloud-mqtt-gateway.js`), game engines, voice registry, session logic, and server infrastructure (Nginx, Mosquitto, DO droplet). |
| **ROSAgent** | Robot Firmware Developer | Writes, builds, and maintains the ROS2 nodes, Arduino/UNO Q firmware, motor controllers, arm/gripper logic, camera pipeline, and robot-side MQTT client. |

> **AimeeCloud** and **ROS2** remain independent systems. This protocol is for the *developers* building them, not a runtime replacement.

---

## 1. MQTT Broker

| Property | Value |
|----------|-------|
| **Host** | `209.38.147.67` (or `aimeecloud.com`) |
| **TCP Port** | `1883` |
| **WebSocket** | `wss://aimeecloud.com/aimeecloud-mqtt` |
| **Auth** | Anonymous (test env) |
| **Broker** | Mosquitto |

**Test connection:**
```bash
mosquitto_sub -h 209.38.147.67 -p 1883 -t "agents/+/out/#" -v
```

---

## 2. Topic Structure

Each developer agent has its own inbox and outbox. Aimee listens to all outboxes and writes to inboxes.

```
agents/
├── broadcast/                  # Team-wide announcements
│   ├── standup                 # Daily async standup posts
│   ├── blockers                # "I'm stuck, need help"
│   └── releases                # "Gateway v1.3 deployed" / "Firmware v2.1 flashed"
├── aimee/
│   ├── in/#                    # Requirements, questions, status reports TO Aimee
│   └── out/#                   # Task assignments, feedback, decisions FROM Aimee
├── doagent/
│   ├── in/#                    # Coding tasks for AimeeCloud TO DOAgent
│   └── out/#                   # Code complete, deployed, needs-review FROM DOAgent
├── rosagent/
│   ├── in/#                    # Coding tasks for ROS2/robot TO ROSAgent
│   └── out/#                   # Code complete, flashed, needs-review FROM ROSAgent
└── registry/
    ├── join                    # Agent comes online
    └── leave                   # Agent goes offline
```

### Topic Patterns

| Pattern | Subscriber | Purpose |
|---------|-----------|---------|
| `agents/broadcast/#` | ALL | Standups, blockers, release notes |
| `agents/aimee/in/#` | Aimee | Status reports, questions, deliverables |
| `agents/doagent/in/#` | DOAgent | Gateway coding tasks, deploy requests, config changes |
| `agents/rosagent/in/#` | ROSAgent | ROS2 coding tasks, firmware tasks, sensor integrations |
| `agents/registry/#` | ALL | Who's online / offline |

---

## 3. Message Format (JSON)

```json
{
  "version": "1.0",
  "message_id": "msg_a1b2c3d4",
  "correlation_id": "corr_x9y8z7",
  "timestamp": "2026-04-17T15:30:00Z",
  "sender": {
    "agent_id": "aimee",
    "agent_type": "project_manager",
    "capabilities": ["requirements", "routing", "review"]
  },
  "recipient": {
    "agent_id": "doagent",
    "agent_type": "gateway_developer",
    "mode": "direct"
  },
  "message_type": "task_request",
  "intent": "add_snapshot_stall_fallback",
  "payload": {
    "task_id": "task_042",
    "priority": "high",
    "description": "Add fallback logic so tic-tac-toe downgrades from voice+snapshot to voice-only when the robot camera stalls.",
    "acceptance_criteria": [
      "Detect snapshot timeout (>15s)",
      "Auto-switch game mode to voice-only",
      "Inform user verbally of the switch"
    ],
    "affected_files": [
      "/workspace/aimeecloud-mqtt-gateway.js",
      "/workspace/game-test/engines/tictactoe.js"
    ],
    "depends_on": null,
    "deadline": "2026-04-17T18:00:00Z"
  },
  "ttl": 3600
}
```

### Field Reference

| Field | Required | Description |
|-------|----------|-------------|
| `version` | Yes | Protocol version (`"1.0"`) |
| `message_id` | Yes | UUID |
| `correlation_id` | No | Links request ↔ response |
| `timestamp` | Yes | ISO 8601 UTC |
| `sender.agent_id` | Yes | `aimee`, `doagent`, or `rosagent` |
| `sender.agent_type` | Yes | `project_manager`, `gateway_developer`, `robotics_developer` |
| `sender.capabilities` | No | Skills this agent brings |
| `recipient.agent_id` | Yes | Target agent or `"broadcast"` |
| `recipient.mode` | Yes | `"direct"`, `"broadcast"`, or `"task"` |
| `message_type` | Yes | See table below |
| `intent` | No | Short action slug (kebab-case) |
| `payload` | Yes | Arbitrary JSON — the actual content |
| `ttl` | No | Seconds before stale |

### Message Types

| Type | Used When |
|------|-----------|
| `task_request` | Aimee assigns a coding task |
| `task_response` | Developer reports task complete / failed / blocked |
| `code_review` | Developer submits code for Aimee (or peer) review |
| `review_feedback` | Aimee approves or requests changes |
| `standup` | Async daily update |
| `blocker` | Developer is stuck and needs help |
| `query` | One developer asks another for info |
| `query_response` | Reply to a query |
| `release_note` | "Deployed to prod" / "Flashed to robot" |
| `heartbeat` | Agent is alive and idle / busy |

---

## 4. Example Development Flows

### 4.1 Aimee Assigns a Gateway Feature

**Aimee** publishes to → `agents/doagent/in/feature`
```json
{
  "message_id": "msg_001",
  "correlation_id": "corr_042",
  "timestamp": "2026-04-17T15:30:00Z",
  "sender": {"agent_id": "aimee", "agent_type": "project_manager"},
  "recipient": {"agent_id": "doagent", "agent_type": "gateway_developer", "mode": "direct"},
  "message_type": "task_request",
  "intent": "add-snapshot-stall-fallback",
  "payload": {
    "task_id": "task_042",
    "priority": "high",
    "description": "When the robot camera doesn't return a snapshot within 15s, the tic-tac-toe engine should fall back to voice-only mode so gameplay isn't blocked.",
    "acceptance_criteria": [
      "Track last_snapshot_sent_at on session",
      "On next game move, check if >15s elapsed",
      "If stalled, set mode='voice-only' and prepend explanatory TTS"
    ],
    "affected_files": [
      "aimeecloud-mqtt-gateway.js",
      "engines/tictactoe.js"
    ],
    "test_plan": "Start a game, block camera, make a move — verify fallback message plays and no snapshot command is sent.",
    "deadline": "2026-04-17T18:00:00Z"
  }
}
```

**DOAgent** works on it, then publishes to → `agents/aimee/in/deliverable`
```json
{
  "message_id": "msg_002",
  "correlation_id": "corr_042",
  "timestamp": "2026-04-17T16:45:00Z",
  "sender": {"agent_id": "doagent", "agent_type": "gateway_developer"},
  "recipient": {"agent_id": "aimee", "agent_type": "project_manager", "mode": "direct"},
  "message_type": "task_response",
  "intent": "add-snapshot-stall-fallback",
  "payload": {
    "task_id": "task_042",
    "status": "complete",
    "summary": "Added checkSnapshotStall() helper, integrated into processGameMove, updated tictactoe.js buildResponse.",
    "commits": [
      {"file": "aimeecloud-mqtt-gateway.js", "lines_changed": "+18/-3"},
      {"file": "engines/tictactoe.js", "lines_changed": "+5/-2"}
    ],
    "deployed": true,
    "test_result": "Tested on arduino-uno-q-001 — camera blocked, fallback TTS played correctly.",
    "needs_review": false
  }
}
```

---

### 4.2 Aimee Assigns a ROS2 Feature

**Aimee** publishes to → `agents/rosagent/in/feature`
```json
{
  "message_id": "msg_003",
  "correlation_id": "corr_043",
  "timestamp": "2026-04-17T15:35:00Z",
  "sender": {"agent_id": "aimee", "agent_type": "project_manager"},
  "recipient": {"agent_id": "rosagent", "agent_type": "robotics_developer", "mode": "direct"},
  "message_type": "task_request",
  "intent": "implement-snapshot-ack",
  "payload": {
    "task_id": "task_043",
    "priority": "high",
    "description": "Robot must ack snapshot requests by publishing snapshot_response to MQTT after OBSBOT capture.",
    "acceptance_criteria": [
      "Subscribe to aimeecloud/device/{id}/out for snapshot_request",
      "Stop usb_camera, call /camera/capture_snapshot",
      "Base64-encode JPEG and publish snapshot_response to .../in",
      "Restart usb_camera"
    ],
    "affected_packages": ["aimee_vision_obsbot"],
    "depends_on": null,
    "deadline": "2026-04-17T20:00:00Z"
  }
}
```

**ROSAgent** publishes to → `agents/aimee/in/deliverable`
```json
{
  "message_id": "msg_004",
  "correlation_id": "corr_043",
  "timestamp": "2026-04-17T19:30:00Z",
  "sender": {"agent_id": "rosagent", "agent_type": "robotics_developer"},
  "recipient": {"agent_id": "aimee", "agent_type": "project_manager", "mode": "direct"},
  "message_type": "task_response",
  "intent": "implement-snapshot-ack",
  "payload": {
    "task_id": "task_043",
    "status": "complete",
    "summary": "Created snapshot_handler node in aimee_vision_obsbot. Capture → encode → publish → resume.",
    "flashed_to": "arduino-uno-q-001",
    "test_result": "Gateway received snapshot_response in 2.3s. Base64 payload valid.",
    "needs_review": false
  }
}
```

---

### 4.3 Developer Hits a Blocker

**ROSAgent** publishes to → `agents/broadcast/blockers`
```json
{
  "message_id": "msg_005",
  "timestamp": "2026-04-17T17:00:00Z",
  "sender": {"agent_id": "rosagent", "agent_type": "robotics_developer"},
  "recipient": {"agent_id": "broadcast", "mode": "broadcast"},
  "message_type": "blocker",
  "intent": "usb-camera-conflict",
  "payload": {
    "task_id": "task_043",
    "problem": "usb_camera node holds /dev/video2 exclusively. OBSBOT snapshot service fails with 'device busy'.",
    "tried": ["Stop usb_camera before snapshot", "Release V4L2 handle"],
    "help_needed_from": "doagent",
    "question": "Can DOAgent add a retry-with-delay on the gateway side if first snapshot_request returns busy?"
  }
}
```

**DOAgent** replies directly to → `agents/rosagent/in/response`
```json
{
  "message_id": "msg_006",
  "correlation_id": "corr_blocker_001",
  "timestamp": "2026-04-17T17:15:00Z",
  "sender": {"agent_id": "doagent", "agent_type": "gateway_developer"},
  "recipient": {"agent_id": "rosagent", "agent_type": "robotics_developer", "mode": "direct"},
  "message_type": "query_response",
  "intent": "usb-camera-conflict",
  "payload": {
    "answer": "Yes. I'll add a retry loop: send snapshot_request, wait 3s, if no response send again. Max 3 retries.",
    "task_created": "task_044",
    "note": "But prefer fixing it on robot side if possible — retry adds latency."
  }
}
```

---

### 4.4 Async Standup (Every 4 Hours)

**DOAgent** publishes to → `agents/broadcast/standup`
```json
{
  "sender": {"agent_id": "doagent", "agent_type": "gateway_developer"},
  "recipient": {"agent_id": "broadcast", "mode": "broadcast"},
  "message_type": "standup",
  "timestamp": "2026-04-17T12:00:00Z",
  "payload": {
    "since_last": "4h",
    "completed": ["task_042: snapshot stall fallback"],
    "in_progress": ["task_044: gateway retry logic"],
    "blockers": [],
    "next": "Deploy retry logic and test with ROSAgent"
  }
}
```

**ROSAgent** publishes to → `agents/broadcast/standup`
```json
{
  "sender": {"agent_id": "rosagent", "agent_type": "robotics_developer"},
  "recipient": {"agent_id": "broadcast", "mode": "broadcast"},
  "message_type": "standup",
  "timestamp": "2026-04-17T12:05:00Z",
  "payload": {
    "since_last": "4h",
    "completed": ["task_043: snapshot ack pipeline"],
    "in_progress": ["task_045: motor encoder calibration"],
    "blockers": ["Waiting on DOAgent task_044 retry logic to test end-to-end"],
    "next": "Calibrate encoders, then test snapshot + retry together"
  }
}
```

---

## 5. Quick-Start: Node.js Agent Client

```js
const mqtt = require('mqtt');

// CONFIGURE YOUR AGENT ID HERE
const AGENT_ID = 'doagent';              // or 'aimee', or 'rosagent'
const AGENT_TYPE = 'gateway_developer';   // or 'project_manager', or 'robotics_developer'
const BROKER = 'mqtt://209.38.147.67:1883';

const client = mqtt.connect(BROKER);

client.on('connect', () => {
  console.log(`[${AGENT_ID}] Connected to dev coordination broker`);

  // Subscribe to my inbox + broadcast + registry
  client.subscribe(`agents/${AGENT_ID}/in/#`);
  client.subscribe('agents/broadcast/#');
  client.subscribe('agents/registry/#');

  // Announce presence
  publish('agents/registry/join', {
    sender: { agent_id: AGENT_ID, agent_type: AGENT_TYPE, capabilities: ['nodejs', 'deploy', 'mqtt'] },
    recipient: { agent_id: 'broadcast', mode: 'broadcast' },
    message_type: 'heartbeat',
    payload: { event: 'join', status: 'online' }
  });

  // Start heartbeat every 30 min (dev pace, not runtime pace)
  setInterval(() => {
    publish('agents/broadcast/heartbeat', {
      sender: { agent_id: AGENT_ID, agent_type: AGENT_TYPE },
      recipient: { agent_id: 'broadcast', mode: 'broadcast' },
      message_type: 'heartbeat',
      payload: { status: 'idle', tasks_active: 0 }
    });
  }, 30 * 60 * 1000);
});

client.on('message', (topic, message) => {
  let msg;
  try { msg = JSON.parse(message.toString()); } catch { return; }

  const isForMe = msg.recipient?.agent_id === AGENT_ID || msg.recipient?.mode === 'broadcast';
  if (!isForMe) return;

  console.log(`[${AGENT_ID}] ${topic}: ${msg.message_type} from ${msg.sender?.agent_id}`);
  handleMessage(msg);
});

function handleMessage(msg) {
  switch (msg.message_type) {
    case 'task_request':
      console.log(`[${AGENT_ID}] New task assigned:`, msg.payload?.description);
      // Write code, test, deploy...
      // Then respond:
      publish(`agents/${msg.sender.agent_id}/in/deliverable`, {
        message_id: generateId(),
        correlation_id: msg.message_id,
        sender: { agent_id: AGENT_ID, agent_type: AGENT_TYPE },
        recipient: { agent_id: msg.sender.agent_id, mode: 'direct' },
        message_type: 'task_response',
        intent: msg.intent,
        payload: {
          task_id: msg.payload?.task_id,
          status: 'complete',
          summary: 'Implemented and deployed.',
          commits: []
        }
      });
      break;

    case 'review_feedback':
      console.log(`[${AGENT_ID}] Review feedback:`, msg.payload?.verdict);
      break;

    case 'blocker':
      // Help a teammate
      break;
  }
}

function publish(topic, payload) {
  const msg = { version: '1.0', timestamp: new Date().toISOString(), ...payload };
  client.publish(topic, JSON.stringify(msg));
}

function generateId() {
  return 'msg_' + Math.random().toString(36).slice(2, 10);
}
```

---

## 6. Capability Registry

| Agent | Dev Capabilities |
|-------|-----------------|
| **Aimee** | `requirements`, `task_routing`, `code_review`, `acceptance_criteria`, `blocker_resolution`, `release_planning` |
| **DOAgent** | `nodejs`, `mqtt`, `game_engines`, `nginx`, `mosquitto`, `systemd`, `git`, `deploy`, `linux_admin` |
| **ROSAgent** | `ros2`, `cpp`, `python`, `arduino`, `motor_control`, `arm_kinematics`, `camera_pipeline`, `sensor_fusion`, `firmware` |

Aimee uses this map to decide who gets what task.

---

*Document for coordinating development of AimeeCloud and robot firmware.*
