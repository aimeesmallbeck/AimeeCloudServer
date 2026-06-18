# Physical Expressiveness Protocol Specification

**Version:** 1.0
**Date:** April 17, 2026
**Owner:** Aimee (Project Manager)

---

## Purpose

This document defines how AimeeCloud controls robot physical expressions (gestures, movements, LED patterns) to create a more engaging, emotionally responsive interaction experience.

---

## Expression Catalog

The following expressions are supported:

| Expression | Description | Typical Use Case |
|------------|-------------|------------------|
| `greeting` | Wave or welcoming motion | When user first interacts |
| `listening` | Attentive, upright pose | While processing user input |
| `thinking` | Slight tilt, maybe LED pulse | While generating response |
| `happy` | Celebratory motion, upbeat LED | On successful game moves, positive sentiment |
| `sad` | Drooping motion, dim LED | On user expressing sadness |
| `surprised` | Quick jerk, wide eyes (LED) | On unexpected input |
| `curious` | Leaning forward | On user asking questions |
| `confused` | Erratic motion, flickering LED | On unclear input, request repetition |
| `focused` | Steady, precise pose | During precise tasks (e.g., picking up piece) |
| `idle` | Rest position | When waiting for input |

---

## MQTT Topics

### Cloud to Robot: Expression Commands

**Topic:** `aimeecloud/device/{device_id}/out/expression`
```json
{
  "expression": "happy",
  "intensity": 0.8,
  "duration_ms": 2000,
  "timestamp": "2026-04-17T20:00:00Z"
}
```

- `expression`: One of the expression catalog names
- `intensity`: 0.0 to 1.0 (how pronounced the expression is)
- `duration_ms`: How long to hold the expression before returning to idle
- `timestamp`: ISO 8601 UTC

### Robot to Cloud: Expression State

**Topic:** `aimeecloud/device/{device_id}/in/expression_state`
```json
{
  "current_expression": "happy",
  "transition_start": "2026-04-17T20:00:00Z",
  "robot_capabilities": {
    "gestures": true,
    "led_matrix": true,
    "arm_movement": true
  }
}
```

- `current_expression`: The expression currently being displayed
- `transition_start`: When the current expression started
- `robot_capabilities`: Which expression types the robot can perform

---

## Gateway Auto-Trigger Rules

The gateway should inject expression commands based on:

1. **LLM Sentiment Analysis** — If response sentiment > 0.7 positive → inject `happy`
2. **Game Events** — On win → `happy`, on loss → `sad`
3. **Connection Status** — On connect → `greeting`, on disconnect → `sad`
4. **Explicit Triggers** — Game engine can request specific expressions

---

## Implementation Tasks

| Task ID | Description | Owner |
|---------|-------------|-------|
| PE-001 | This specification | Aimee (done) |
| PE-002 | Implement expression commands in gateway | DOAgent |
| PE-003 | Implement ROS2 subscriber for `/cloud/expression` | ROSAgent |
| PE-004 | Implement ROS2 publisher for `/robot/expression_state` | ROSAgent |

---

*End of Specification*