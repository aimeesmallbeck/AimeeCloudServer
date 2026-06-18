# Task: Update Protocol Spec with Tiered Access

## Context
The AimeeCloud protocol spec needs to be updated to document the new tiered access system.

## Changes Needed

1. **Update session_init example** (around line 51) to include `tier` field:

```json
{
  "type": "session_init",
  "session_id": "sess_abc123",
  "device_id": "arduino-uno-q-001",
  "status": "connected",
  "tier": "free",
  "expires_in": 600,
  "ttl": 600,
  "timestamp": "2026-04-16T07:00:00.000Z"
}
```

2. **Add new section after Session Management** (after 3.3 Disconnect) documenting:

### 3.4 Tiered Access

AimeeCloud supports tiered access for different use cases:

| Tier | Description | Limits |
|------|-------------|--------|
| `free` | Hobbyist / testing | 2 concurrent sessions, 10 sessions/day, 5 API calls/min |
| `paid` | Manufacturer / production | Unlimited sessions and API calls |

**API Key:**
- Robots can include an `api_key` field in their connect message
- API keys are mapped to tiers via configuration
- If no API key is provided, the session has `tier: null` (unlimited access for backward compatibility)

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

## File to Modify
- `/home/scott/aimeecloud-deploy/AIMEECLOUD_PROTOCOL.md`

## Output
Updated protocol spec with tiered access documentation.