# Task: Implement Tiered Access System (Free/Paid Tiers)

## Context

AimeeCloud needs a tiered access system for the business model:
- **Free tier**: Hobbyists testing their robots (limited API calls, limited sessions)
- **Paid tier**: Manufacturers shipping products (unlimited access, priority support)

## What To Implement

### 1. Create a simple tier configuration file

Create `/home/scott/aimeecloud-deploy/tier-config.json`:

```json
{
  "free": {
    "name": "Hobbyist",
    "max_concurrent_sessions": 2,
    "max_sessions_per_day": 10,
    "max_api_calls_per_minute": 5,
    "features": ["basic_games", "basic_conversation"],
    "tts_mode": "client"
  },
  "paid": {
    "name": "Manufacturer",
    "max_concurrent_sessions": 100,
    "max_sessions_per_day": -1,  // unlimited
    "max_api_calls_per_minute": -1,  // unlimited
    "features": ["all_games", "all_conversation", "agent_workflow", "server_tts"],
    "tts_mode": "server"
  }
}
```

### 2. Add API key validation with tiers

Update the gateway to:
- Read `X-API-Key` from the connect message or environment
- Look up the tier from the API key
- Enforce rate limits per tier
- Return error if limits exceeded

### 3. Add tier info to session

When a session is created, store the tier info in the session object:
```javascript
session.tier = 'free';  // or 'paid'
session.api_key = 'ac_...';
```

### 4. Add rate limiting middleware

- Track API calls per API key per minute
- Return 429 Too Many Requests if limit exceeded
- Use an in-memory Map for now (can be externalized later)

## Files to Modify

- Create: `/home/scott/aimeecloud-deploy/tier-config.json`
- Modify: `/home/scott/aimeecloud-Deploy/aimeecloud-mqtt-gateway.js` — add tier lookup and rate limiting

## Constraints
- Do NOT break existing behavior (no API key = unlimited for now, backward compatible)
- Add tier info as optional field, only enforce if API key present
- Keep it simple — in-memory rate limiting is fine for demo
- Deploy after implementation

## Output
Working tier system that:
- Validates API keys against tier config
- Tracks and limits free tier usage
- Allows paid tier unlimited access
