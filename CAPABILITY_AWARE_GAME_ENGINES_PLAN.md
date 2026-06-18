# Plan: Capability-Aware Game Engines for AimeeCloud

## Overview
Refactor the game engine interface so that each engine knows the robot’s capabilities and can tailor its response mode from "most capable" to "least capable." This allows a single game (e.g., tic-tac-toe or chess) to dynamically use voice-only, voice+snapshot, or full physical manipulation (arm + platform) depending on the hardware connected.

---

## 1. Standard Capability Contract

The robot already sends `capabilities` during `connect`. We will standardize a small set of **capability flags** that the gateway and game engines agree on:

| Flag | Meaning |
|------|---------|
| `voice` | Robot can speak TTS (always assumed true if `tts` in output) |
| `display` | Robot has a screen to show text/graphics |
| `snapshot` | Robot has a camera and can send a snapshot command |
| `arm` | Robot has an articulated arm for pick-and-place |
| `platform` | Robot can move on a surface (drive to a board position, rotate, etc.) |

These flags are derived from the existing `capabilities.output` array at session creation time and stored in `session.capabilities._gameFlags` (or similar normalized field).

---

## 2. Capability Ranking per Game Engine

Each game engine exports a **capability priority ladder** — an ordered list of "modes" from richest to poorest. The engine selects the highest mode that the robot satisfies.

### Example: Tic-Tac-Toe
```js
const ticTacToeModes = [
  { name: 'voice+snapshot', needs: ['voice', 'snapshot'] },
  { name: 'voice-only',     needs: ['voice'] },
  { name: 'display-only',   needs: ['display'] }
];
```
- If the robot has `voice` + `snapshot`, the engine returns spoken prompts **and** asks the gateway to issue a `snapshot` command after each move so the player can see the board.
- If only `voice`, the engine relies entirely on spoken position names ("top left", "center") and spoken board state updates.

### Example: Chess (future)
```js
const chessModes = [
  { name: 'arm+voice+snapshot', needs: ['arm', 'voice', 'snapshot'] },
  { name: 'arm+voice',          needs: ['arm', 'voice'] },
  { name: 'voice+snapshot',     needs: ['voice', 'snapshot'] },
  { name: 'voice-only',         needs: ['voice'] }
];
```
- With `arm`, the robot physically picks and places pieces on a real board.
- Without `arm`, the game falls back to voice+snapshot (player moves pieces themselves, robot confirms via photo) or voice-only.

### Example: Candyland / Yahtzee
- `voice+snapshot` for confirming dice or board positions.
- `voice+platform` for a future physical board where the robot drives to the player’s piece to "move" it.

---

## 3. Updated Game Engine Interface

### 3.1 `createState(capabilities)`
Accepts the normalized capability flags and stores the selected mode inside the game state:
```js
function createState(capabilities) {
  const mode = selectMode(ticTacToeModes, capabilities);
  return {
    board: Array(9).fill(''),
    status: 'playing',
    turn: 'X',
    mode: mode.name,   // e.g. "voice+snapshot"
    // ... rest of state
  };
}
```

### 3.2 `makeMove(state, move, player, capabilities)`
The third argument stays `player` (`'X'` or `'O'`), but a fourth `capabilities` argument is added for convenience (the engine can also read `state.mode`).

### 3.3 `buildResponse(state, lastPos, symbol, actionDesc)` → returns `{ text, tts, voice, commands }`
Instead of returning plain text, the response builder returns a **command list** that the gateway forwards to the robot:

```js
{
  text: "🎮 Tic-Tac-Toe! You are X...",
  tts: "Tic-Tac-Toe! You are X, I'm O...",
  voice: 'game-announcer',
  commands: [
    { type: 'snapshot', camera: 'front', purpose: 'show_board' }
  ]
}
```

The `commands` array is specific to the selected mode. For `voice-only`, `commands` is empty (or contains just a `display` command if the robot has a screen). For `voice+snapshot`, it contains a `snapshot` after every board-changing move.

---

## 4. Response Enrichment & Turn Flow Orchestration

### 4.1 Gateway changes
- `startGame(session, gameName)` already captures `session.capabilities`. Pass them into `engine.createState(session.capabilities)`.
- `processGameMove(session, gameName, move)` passes capabilities into `engine.makeMove(...)`.
- The game helper functions (`buildTicTacToeResponse`, etc.) are replaced by engine-native `buildResponse` calls that return `commands`.
- The gateway merges any `commands` from the engine into the final MQTT payload under the `commands` key (already supported by the protocol and the robot).

### 4.2 Turn-flow logic inside the engine
For tic-tac-toe the flow is simple:
1. Player says a position.
2. Engine updates board, checks for win/tie.
3. If still playing, engine runs its own move.
4. Engine builds response with updated board + optional snapshot command.
5. Gateway publishes `game_update` with `state`, `text`, `tts`, `voice`, and `commands`.

For chess with an arm:
1. Player says a move (e.g., "knight to f3").
2. Engine updates board state.
3. Engine appends `commands` for the arm to pick and place the player’s piece.
4. Engine calculates its own move.
5. Engine appends a second arm command to move its own piece.
6. Engine appends a `snapshot` command to show the new board state.
7. Gateway publishes all commands in order.

The robot executes `commands` sequentially with small pauses between them.

---

## 5. File Modifications

| File | Change |
|------|--------|
| `aimeecloud-mqtt-gateway.js` | Normalize capabilities into flags; pass them to game engines; forward `commands` from game responses. |
| `tic-tac-toe` engine | Add `selectMode`, `createState(capabilities)`, `buildResponse(state, ...)` returning `commands`. |
| `yahtzee` engine | Same pattern: select mode, return `commands` (e.g., `snapshot` after each roll). |
| `candyland` engine | Same pattern. |
| `AIMEECLOUD_PROTOCOL.md` | Document that `game_update` may include `commands` for physical actions. |

---

## 6. Rollout Steps

1. **Capability normalizer** in gateway: map `capabilities.output` → `{ voice, display, snapshot, arm, platform }`.
2. **Refactor `tic-tac-toe.js`** as the pilot engine:
   - Add `selectMode(modes, capabilities)` helper.
   - Return `{ text, tts, voice, commands }` from the response builder.
   - For `voice+snapshot`, append a `snapshot` command after every move.
3. **Update gateway** `startGame` and `processGameMove` to consume the new response shape.
4. **Test** with the robot (voice-only mode first, then voice+snapshot if camera is ready).
5. **Apply same pattern** to `yahtzee.js` and `candyland.js`.
6. **Future:** Add `chess.js` with `arm` support once a physical chess board is available.

---

## 7. Trade-offs Considered

- **Alternative: Robot decides how to render the game.** Rejected because it pushes game logic (what move just happened, which piece moved) into the robot firmware. Keeping the engine as the "brain" ensures the robot only executes commands.
- **Alternative: Gateway synthesizes board images and streams them.** Rejected as high-latency and high-bandwidth. A `snapshot` command lets the robot take the photo locally and display it on its own screen.

This plan keeps the cloud gateway as the game-rule authority while letting each game engine exploit the robot’s hardware in the richest way possible.
