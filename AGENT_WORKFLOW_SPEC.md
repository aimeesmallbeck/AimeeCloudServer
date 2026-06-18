# AimeeCloud Agent Workflow: Auto-Generated Games & Lesson Plans

## The Vision

When a user says "Let's play Monopoly" or "Teach me about the solar system," AimeeCloud doesn't just route to a pre-built game — it **dynamically generates** the complete robot experience:

1. **Research Agent** — Understands the game/lesson, rules, interactions
2. **Capability Mapper** — Analyzes what the robot can do (voice, arm, camera, movement)
3. **Experience Designer** — Creates the interaction flow for this robot's capabilities
4. **Engine Generator** — Writes the game engine or lesson module
5. **Deployment** — Live in minutes, no human developer needed

---

## Workflow: "Let's Play Monopoly"

### Step 1: Research Agent
```
Prompt: "Research Monopoly. Extract: complete rules, player actions, 
turn structure, victory conditions, physical components needed, 
typical game duration, skill elements (negotiation, math, strategy)."
```
**Output:** Structured game definition (JSON schema)

### Step 2: Capability Mapper
```
Input: Robot capabilities from session connect: { voice, snapshot, arm, platform }
Output: Mapped interaction modes
```
| Robot Capability | Monopoly Interaction |
|-----------------|----------------------|
| `voice + snapshot` | "Show me the board" → capture → describe |
| `voice + arm` | Move piece automatically, collect rent physically |
| `voice + platform` | Drive to different "properties" on floor |
| `voice only` | Full audio game, player moves pieces |

### Step 3: Experience Designer
```
For each game phase (roll, buy, trade, build, auction):
- What does the robot say?
- What does the robot do? (gestures, movements, snapshots)
- How does it express emotions? (winning, losing, bidding)
```
**Output:** Interaction script with timing, TTS, commands

### Step 4: Engine Generator
```javascript
// Auto-generated Monopoly engine
const monopolyEngine = {
  name: "Monopoly",
  minPlayers: 2,
  maxPlayers: 8,
  mode: "voice+arm",  // selected based on robot capabilities
  
  state: { board: [...], players: [...], bank: {...} },
  
  parseMove: (utterance) => { /* NLP for "I want to buy Boardwalk" */ },
  
  makeMove: (player, action) => { /* Game logic */ },
  
  buildResponse: (action, result) => {
    return {
      tts: "You bought Boardwalk for $400! ...",
      voice: "aimee-excited",
      commands: [
        { type: "arm", action: "move_piece", to: "boardwalk" },
        { type: "gesture", name: "celebrate_small" }
      ]
    };
  }
};
```

### Step 5: Deploy
- Hot-load engine into gateway
- Begin game with intro: "Let's play Monopoly! I'll be the banker..."

---

## Same Workflow for Education: "Teach Me About the Solar System"

### Step 1: Research Agent
- Extract key concepts, facts, level-appropriate explanations
- Identify visual/physical aids that would help

### Step 2: Capability Mapper
- `voice + snapshot`: "Let me show you Jupiter" → capture planet image → describe
- `voice + arm`: Point to physical solar system model
- `voice + platform`: Drive to represent distances (scaled)

### Step 3: Experience Designer
- Structure lesson: intro → deep-dive 3 planets → quiz → summary
- Interactive check-ins: "Want to learn more about Mars?"
- Quiz logic with celebration/encouragement

### Step 4: Content Generator
- Generate lesson script
- Generate quiz questions
- Generate follow-up suggestions

---

## Technical Implementation

### Agent Workflow Architecture

```
User: "Let's play Monopoly"
         |
         v
+------------------+
| AimeeAgent LLM   | ← detects new game request
+------------------+
         |
         v
+------------------+
| GameDiscovery    | ← checks if engine exists
| Agent            |
+------------------+
         |
    [Engine not found]
         |
         v
+------------------+
| GameGenerator    | ← NEW: Agent workflow
| Workflow         |
+------------------+
         |
    +----+----+----+
    |    |    |    |
    v    v    v    v
+----+ +----+ +----+ +----+
|Research| |Map  | |Design| |Code |
|Agent  | |Agent| |Agent| |Gen  |
+----+ +----+ +----+ +----+
    |    |    |    |
    +----+----+----+
         |
         v
+------------------+
| Hot-load engine  | ← into gateway
+------------------+
         |
         v
    Start game!
```

### GameGenerator Workflow (Pseudo-code)

```javascript
async function generateGame(userRequest, robotCapabilities) {
  // 1. Research
  const gameSpec = await researchAgent.analyze(userRequest);
  // Output: { name, rules, components, duration, phases }
  
  // 2. Map to capabilities
  const interactionMode = capabilityMapper.map(gameSpec, robotCapabilities);
  // Output: { mode: "voice+arm+Snapshot", fallback: "voice-only" }
  
  // 3. Design experience
  const experience = await designAgent.create(gameSpec, interactionMode);
  // Output: { intro, phases[], ending, emotions[] }
  
  // 4. Generate engine code
  const engineCode = await codeGen.generate(gameSpec, experience);
  // Output: JavaScript engine module
  
  // 5. Validate (sandbox test)
  await validator.test(engineCode);
  
  // 6. Deploy
  return hotLoad(engineCode);
}
```

---

## Why This Wins

| Traditional | AimeeCloud |
|-------------|------------|
| 40+ hours to add one game | 2 minutes to generate any game |
| Limited game library | Infinite library via agent |
| Manual capability adaptation | Auto-mapped to any robot |
| Fixed interactions | Dynamic, context-aware |

**Investor pitch:** "We're not a game company — we're an *experience generation platform*. Tell us what you want, we build the robot interaction. Manually? Never again."

---

## Milestones

| Phase | Goal |
|-------|------|
| Phase 2 (May) | Design GameGenerator workflow architecture |
| Phase 3 (June) | Implement Research + Capability Mapper agents |
| Phase 4 (July) | Demo: "Let's play [new game not pre-built]" — auto-generate live |
| Post-demo | Full code generation + hot-loading |

---

## Risk Mitigation

- **Quality control:** Generated games tested in sandbox before deployment
- **Fallback:** If generation fails, suggest existing games
- **Human review:** Flag unusual games for manual review before hot-load
- **Safety:** Same content filters as regular AimeeAgent

---

*Document Version: 0.1*  
*Created: April 17, 2026*
