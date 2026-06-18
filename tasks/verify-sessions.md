# Task: Verify Multi-Robot Session Isolation

## Context
Test that multiple robots can connect simultaneously without interference. Ron (arduino-uno-q-001) is already connected. We need to verify:
1. Sessions are isolated by session_id
2. Each robot only receives its own messages
3. No cross-talk between robots

## Action
1. Check current sessions in /tmp/aimeecloud-sessions.json
2. Simulate a second robot connecting (or check if Minnie is already connected)
3. Verify each robot gets its own session with correct device_id

## Output
Verify session isolation is working correctly.