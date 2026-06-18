# Task: ElevenLabs TTS Integration

## Context

The AimeeCloud MQTT gateway (`aimeecloud-mqtt-gateway.js`) currently sends voice metadata (persona, voice ID, provider) in every response. The robot's local TTS node handles synthesis using Lemonfox or gTTS. We want to add ElevenLabs as the primary TTS provider with server-side audio generation, sending audio URLs back to the robot alongside the text.

## Current Architecture

- `voiceRegistry.json` maps personas → voice IDs (all Lemonfox currently)
- Every outbound response includes a `voice` object: `{ persona, id, provider, lang }`
- The robot receives `tts` (text) and `voice` (metadata) and synthesizes locally
- Gateway is Node.js, uses `mqtt` and `openai` (for OpenRouter) packages

## What To Build

### 1. Update `voiceRegistry.json`

Add ElevenLabs voices alongside existing Lemonfox voices. Each persona should have a `providers` array with priority order:

```json
{
  "aimee-default": {
    "providers": [
      { "provider": "elevenlabs", "voice_id": "EXAVITQu4vr4xnSDxMaL", "model": "eleven_turbo_v2_5" },
      { "provider": "lemonfox", "id": "sarah" },
      { "provider": "gtts", "lang": "en" }
    ]
  }
}
```

Use these ElevenLabs voice IDs as reasonable defaults (we can tune later):
- `aimee-default` → "Sarah" or similar warm female voice
- `aimee-surprised` → same voice with different style settings
- `aimee-calm` → same voice with calm style
- `narrator` → a male narrative voice
- For character voices, use whatever makes sense

NOTE: We don't know Scott's exact ElevenLabs voice IDs yet. Use placeholder IDs and make them easy to swap via the registry. The structure matters more than the specific IDs.

### 2. Create `elevenlabs-tts.js` module

A clean module that:
- Takes text + voice config → returns audio URL or audio buffer
- Uses the ElevenLabs REST API (https://api.elevenlabs.io/v1/text-to-speech/{voice_id})
- Supports `eleven_turbo_v2_5` model for low latency
- Returns the audio as a base64-encoded MP3 or a URL
- Has proper error handling and timeout (5 second max)
- Reads API key from environment variable `ELEVENLABS_API_KEY`
- Exports a simple async function: `generateSpeech(text, voiceConfig) → { audio_base64, format, duration_estimate }`

### 3. Update gateway to optionally generate audio

In the response-building pipeline (the `resolveVoice` function and response sending):
- If ElevenLabs is configured (API key present), attempt server-side TTS generation
- Add `tts_audio` field to outbound responses: `{ format: "mp3", audio_base64: "...", provider: "elevenlabs" }`
- If ElevenLabs fails or times out, fall back to Lemonfox metadata (current behavior)
- If Lemonfox fails, fall back to gTTS metadata
- Add a session-level or global flag `tts_mode`: "server" (cloud generates audio) or "client" (robot generates audio)
- Default to "client" mode for now — server-side generation is opt-in per robot capability

### 4. Update the protocol

Add `tts_audio` as an optional field in outbound responses:

```json
{
  "type": "response",
  "tts": "Hello there!",
  "voice": { "persona": "aimee-default", "provider": "elevenlabs" },
  "tts_audio": {
    "format": "mp3",
    "audio_base64": "...",
    "provider": "elevenlabs",
    "voice_id": "EXAVITQu4vr4xnSDxMaL"
  }
}
```

Robots that support audio playback can use `tts_audio` directly. Others ignore it and use `tts` + `voice` for local synthesis.

## Files to Modify

- `/home/scott/aimeecloud-deploy/voiceRegistry.json` — add ElevenLabs voices with fallback chain
- `/home/scott/aimeecloud-deploy/elevenlabs-tts.js` — NEW: ElevenLabs TTS module
- `/home/scott/aimeecloud-deploy/aimeecloud-mqtt-gateway.js` — update `resolveVoice()` and response pipeline
- `/home/scott/aimeecloud-deploy/package.json` — add any new dependencies if needed (probably just `node-fetch` if not already available, or use built-in `https`)

## Constraints

- Do NOT use any npm packages for ElevenLabs — use the REST API directly with Node.js built-in `https` or the existing `fetch` if available
- Do NOT break existing Lemonfox-only behavior — if no ElevenLabs key, everything works as before
- Keep the gateway startup clean — log whether ElevenLabs is configured or not
- Audio generation should be async and non-blocking
- Add `ELEVENLABS_API_KEY` to the environment check at startup

## Testing

After implementation:
1. Gateway should start without ElevenLabs key (graceful degradation)
2. `voiceRegistry.json` should be valid JSON with the new structure
3. The `elevenlabs-tts.js` module should export properly
4. Existing browser test client should still work

## Do NOT

- Deploy to production (no `deploy.sh` run)
- Modify any files outside `/home/scott/aimeecloud-deploy/`
- Change the MQTT topic structure
- Break existing session handling
