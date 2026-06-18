# Task: Define Physical Expressiveness Protocol

## Context
AimeeCloud needs to support physical expressiveness - the robot's physical behaviors that make interactions feel alive. This is a key differentiator for the OpenSauce demo.

## What to Define

Create `/home/scott/aimeecloud-deploy/PHYSICAL_EXPRESSIVENESS_SPEC.md` documenting:

### 1. Expression Types
- **Head tilts** - slight angle changes (e.g., curious, thinking)
- **Head wiggles** - side-to-side motion (e.g., no, playful)
- **LED expressions** - colors/patterns for emotions
- **"Thinking" gestures** - pause with subtle motion during LLM generation
- **Celebration** - happy movements on success
- **Greeting** - wave or similar on connect

### 2. Protocol Structure
Expressions should be sent as part of the robot command array in responses:

```json
{
  "type": "response",
  "sub_type": "aimee_agent",
  "commands": [
    { "type": "expression", "name": "thinking" },
    { "type": "motor", "action": "stop" },
    { "type": "tts", "text": "Let me think about that..." }
  ]
}
```

### 3. Available Expressions
Document the standard expression names:
- `thinking` - pause with subtle movement
- `happy` - celebration/positive feedback
- `sad` - disappointed tone
- `surprised` - unexpected
- `curious` - head tilt
- `greeting` - wave or welcome gesture
- `listening` - attentive posture
- `idle` - default resting state

### 4. ROS2 Topics
For the robot side to implement:
- `/cloud/expression` (std_msgs/String) - receive expression commands
- Format: `{"type": "expression", "name": "thinking", "duration_ms": 2000}`

### 5. Integration with Gateway
The gateway should be able to trigger expressions based on:
- LLM response context (detected emotion)
- Game events (win/lose)
- Explicit commands from the agent

## Output
Create the spec file with complete expression definitions and protocol.