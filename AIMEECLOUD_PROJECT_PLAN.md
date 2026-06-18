# AimeeCloud Project Plan
## Targeting OpenSauce Demo: July 17, 2026

**Date:** April 17, 2026  
**Target:** Hackster Contest + OpenSauce Booth Demo  
**Strategic Context:** Build a *demonstrable, investable SaaS platform* — prove it works on our robots, then generalize for any robot manufacturer. A core differentiator is our **AI-driven agent workflow for automated experience generation**.

---

## Executive Summary

AimeeCloud is a voice-first conversational AI platform for physical robot companions. The July 17 demo proves the platform works end-to-end, demonstrating:
- Natural conversational flow (no wake word)
- Physical expressiveness (what makes robots feel alive)
- **AI-generated games and educational content on demand**
- Cloud architecture that scales to many robots

**Investor Traction Targets (by July 17):**
- ✅ 2 live robots (Ron + Minnie) demonstrating platform
- ✅ Hackster contest submission (public visibility)
- ✅ OpenSauce booth with live demos (B2B leads)
- ✅ Architecture capable of supporting 50+ concurrent robots
- ✅ Documentation ready for manufacturer API integration

---

## Phase 1: Platform Foundation (Now → End April)
**Goal:** Core platform stable; ElevenLabs live; hardware-agnostic architecture begins

### Platform Architecture (Making It Generalizable)
| Task | Owner | Status |
|------|-------|--------|
| Refactor capability-aware protocol to be robot-agnostic | Agent | 📋 TODO |
| Create public API documentation draft (OpenAPI spec) | Agent | 📋 TODO |
| Add multi-robot session isolation (test with Ron + Minnie) | Agent | 📋 TODO |
| Implement tiered access: free tier (hobbyist) vs paid (manufacturer) | Agent | 📋 TODO |

### Hardware Integration (Proof of Concept)
| Task | Owner | Status |
|------|-------|--------|
| Connect RoArm-M3 to Ron, verify serial comms | Scott | 📋 TODO |
| Test arm pick/place via ROS2 topics | Scott | 📋 TODO |
| Verify UGV02 base control | Scott | 📋 TODO |

### ElevenLabs TTS Integration
| Task | Owner | Status |
|------|-------|--------|
| Create ElevenLabs API wrapper in voice registry | Agent | 📋 TODO |
| Add API key to gateway config | Scott | 📋 TODO |
| Test expressive voice samples | Scott | 📋 TODO |
| Configure fallback chain: ElevenLabs → Lemonfox → gTTS | Agent | 📋 TODO |

### Milestone for Phase 1 (April 30)
- [ ] API spec draft complete (v0.1 for investor review)
- [ ] Tiered access system designed (free/paid tiers)
- [ ] Ron speaks with ElevenLabs
- [ ] Session isolation works for 2 robots
- [ ] Gateway restart preserves all sessions

---

## Phase 2: Platform Polish & Agent Workflow Design (May 1-31)
**Goal:** Physical expressiveness; vision; prove scalability; design auto-generation workflow

### Physical Expressiveness (What Delights Users)
| Task | Owner | Status |
|------|-------|--------|
| Define expressiveness protocol: head, LED, gesture, "thinking" | Agent | 📋 TODO |
| Add expressiveness commands to cloud protocol | Agent | 📋 TODO |
| Implement LED expression ROS2 node | Scott | 📋 TODO |
| Add "thinking" pause + gesture during LLM generation | Agent | 📋 TODO |
| Test expressiveness during live conversation | Scott | 📋 TODO |

### Vision Pipeline (Core for Games + Education)
| Task | Owner | Status |
|------|-------|--------|
| Connect snapshot API to gateway | Agent | 📋 TODO |
| Verify OBSBOT PTZ+gesture control via cloud | Scott | 📋 TODO |
| Test: user asks photo → robot captures → describes | Scott | 📋 TODO |
| Handle snapshot timeout (fallback to voice-only) | Agent | 📋 TODO |
| MIPI-CSI upgrade if delivered (optional) | Scott | 📋 TODO |

### Game Engine Demonstration
| Task | Owner | Status |
|------|-------|--------|
| Tic-tac-toe: paper board + camera watch | Agent | 📋 TODO |
| Tic-tac-toe: add celebration gestures | Agent | 📋 TODO |
| Candyland + Yahtzee voice-only modes | Agent | 📋 TODO |
| Test game interruption (weather mid-game) | Scott | 📋 TODO |

### Agent-Driven Experience Generation Workflow Design
| Task | Owner | Status |
|------|-------|--------|
| **Design Core Agents:** Research, Capability Mapper, Experience Designer, Engine Generator | Agent | 📋 TODO |
| **Define Agent Communication Protocol:** How agents pass data (game specs, interaction maps) | Agent | 📋 TODO |
| **Sketch Monopoly Generation Workflow:** Map out steps for a complex game | Agent | 📋 TODO |
| **Sketch Solar System Lesson Plan Generation:** Map out steps for educational content | Agent | 📋 TODO |
| **Plan sandbox testing environment for agent workflows** | Agent | 📋 TODO |

### Developer Experience (For Manufacturer Adoption)
| Task | Owner | Status |
|------|-------|--------|
| Create "Connect Your Robot" guide | Agent | 📋 TODO |
| Document capability negotiation protocol | Agent | 📋 TODO |
| Build browser-based mock robot for testing | Agent | 📋 TODO |
| Set up developer portal landing page | Scott | 📋 TODO |

### Milestone for Phase 2 (May 31)
- [ ] Expressive conversation working
- [ ] Snapshot pipeline live
- [ ] Tic-tac-toe playable with camera
- [ ] **Agent workflow architecture designed**
- [ ] Developer docs draft complete
- [ ] Mock robot test client working

---

## Phase 3: B2B Readiness & Agent Implementation (June 1-30)
**Goal:** Education content; auth; emergency features; actual agent code; manufacturer prep

### Education Modules (Content That Sells)
| Task | Owner | Status |
|------|-------|--------|
| Create 3-5 minute interactive demo lesson | Agent | 📋 TODO |
| Implement Q&A mode (science, math facts) | Agent | 📋 TODO |
| Add learning progress context in session | Agent | 📋 TODO |

### Authentication & Security (Enterprise-Ready)
| Task | Owner | Status |
|------|-------|--------|
| Per-robot API key authentication | Agent | 📋 TODO |
| Google Sign-In for browser test client | Agent | 📋 TODO |
| Rate limiting (free tier: X calls/min, paid: unlimited) | Agent | 📋 TODO |
| Document COPPA/HIPAA considerations | Agent | 📋 TODO |

### Emergency Contact Feature (Care Market Differentiator)
| Task | Owner | Status |
|------|-------|--------|
| Non-911 emergency contact (caregiver notification) | Agent | 📋 TODO |
| User-configurable emergency contact in session | Agent | 📋 TODO |
| Test emergency trigger phrase | Scott | 📋 TODO |

### Agent Workflow Implementation & Demo
| Task | Owner | Status |
|------|-------|--------|
| **Implement Research Agent** | Agent | 📋 TODO |
| **Implement Capability Mapper** | Agent | 📋 TODO |
| **Implement basic Engine Generator (for simple games like Tic-Tac-Toe)** | Agent | 📋 TODO |
| **Demo:** Auto-generate and play Tic-Tac-Toe | Agent | 📋 TODO |

### Multi-Robot Scalability Test
| Task | Owner | Status |
|------|-------|--------|
| Verify Minnie (no arm) connects with same API | Scott | 📋 TODO |
| Test capability negotiation (Ron has arm, Minnie doesn't) | Scott | 📋 TODO |
| Load test: simulate 10 virtual robots | Agent | 📋 TODO |

### Milestone for Phase 3 (June 30)
- [ ] Education demo module ready
- [ ] Tiered auth (free/paid) functional
- [ ] Emergency contact working
- [ ] **First agent workflow demo: Tic-Tac-Toe auto-generation**
- [ ] Minnie cloud-connected
- [ ] Load test passes (10+ simulated robots)
- [ ] Developer portal live

---

## Phase 4: Demo & Launch (July 1-17)
**Goal:** Reliable demo; B2B leads; investor-ready with auto-generation prowess

### Demo Hardening
| Task | Owner | Status |
|------|-------|--------|
| Load test: 50 concurrent sessions | Agent | 📋 TODO |
| Network failover (Wi-Fi drop/reconnect) | Scott | 📋 TODO |
| Gateway restart = zero session loss | Scott | 📋 TODO |
| Health check endpoint for monitoring | Agent | 📋 TODO |

### Booth Experience (OpenSauce)
| Task | Owner | Status |
|------|-------|--------|
| Scripted 3-minute demo flow highlighting auto-generation | Scott | 📋 TODO |
| Backup TTS chain verified | Agent | 📋 TODO |
| Both robots at booth, tested | Scott | 📋 TODO |
| B2B one-pager for manufacturers (emphasizing auto-generation) | Scott | 📋 TODO |
| Lead capture (QR code → demo request) | Scott | 📋 TODO |

### Investor Materials
| Task | Owner | Status |
|------|-------|--------|
| Pitch deck (1-pager) highlighting AI-generated experiences | Scott | 📋 TODO |
| Technical architecture diagram (showing agent workflows) | Agent | 📋 TODO |
| Traction metrics one-pager | Scott | 📋 TODO |

### Demo Day (July 17)
- [ ] Both robots operational
- [ ] **Live demo of auto-generating a game**
- [ ] Expressive, delightful interaction
- [ ] 2+ games playable (some auto-generated)
- [ ] B2B leads collected
- [ ] Hackster submission submitted

---

## Investor Traction Metrics

| Metric | Current | Target by July 17 |
|--------|---------|-------------------|
| Live robots on platform | 2 (Ron + Minnie) | 2 |
| API documentation | Draft | v1.0 |
| Developer signups | 0 | 5+ (friends/family) |
| Concurrent sessions tested | Unknown | 50+ |
| B2B conversations | 0 | 10+ (at OpenSauce) |
| **AI-generated experiences demoed** | N/A | Yes (simple game live) |
| Press/creator reach | 0 | Hackster + OpenSauce |

---

## Technical Architecture (Scalable)

```
User Request (e.g., "Play Monopoly")
       |
       v
+------------------+
| AimeeAgent LLM   | ← Detects request type
+------------------+
       |
       v
+--------------------------+
| Experience Generator     | ← Agent Workflow
| (Research, Map, Design,  |
|  Generate Agents)        |
+--------------------------+
       |
       v
+---------------------------+
|  AimeeCloud Gateway       | ← Loads generated engine
|  • Session management     |
|  • Capability negotiation |
|  • Tiered auth            |
+---------------------------+
       |
       +----> Bot Server (MonMosquitto)
       +----> LLM Service (OpenRouter)
       +----> TTS Service (ElevenLabs)
```

### Key Files
| File | Purpose |
|------|---------|
| `/workspace/aimeecloud-mqtt-gateway.js` | Main gateway |
| `/home/scott/aimeecloud-deploy/docs/api-spec.yaml` | Public API |
| `AGENT_WORKFLOW_SPEC.md` | Agent workflow design |

---

## Exit Strategy Value Props

**What acquirers want:**
1. **Working Product, Not Prototype** — Live robots, real users, measurable engagement.
2. **AI-Generated Experiences Platform** — This is the killer feature. "On-demand game/lesson creation" is enormous.
3. **Platform, Not One-Off** — Works with ANY robot via capability negotiation.
4. **Clear Business Model** — Free tier → paid tiers, API-based, focus on manufacturers.
5. **Technical Moat** — Capability-aware games, voice-first UX, cloud+edge hybrid, *AI generation*.
6. **Traction Story** — Hackster, OpenSauce, B2B leads, *auto-generation demo*.

**Kill criteria for acquisition target:**
- [ ] 2+ live robots demonstrating platform
- [ ] **Live demo of AI-generated game/lesson**
- [ ] API documentation ready for developer onboarding
- [ ] At least one manufacturer conversation/interest
- [ ] Clear tiered pricing model
- [ ] Measurable session engagement

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| RoArm-M3 hardware delay | Medium | High | Voice-only games, focus on agent workflow |
| ElevenLabs API fails | Low | Medium | Fallback to Lemonfox |
| Network at booth | Medium | High | Local LLM fallback |
| **Agent generation quality low** | **Medium** | **High** | **Sandbox testing, staged rollout, human review for complex cases** |
| **No manufacturer interest in auto-gen** | **Low** | **High** | **Focus on demos and developer portal** |
| Gateway instability | Low | Critical | Auto-restart + health checks |

---

## Weekly Time Budget

**Scott: 30-40 hrs/week**

| Week | Focus |
|------|-------|
| Apr 17-23 | ElevenLabs + **Agent workflow design** |
| Apr 24-30 | Hardware testing + session isolation |
| May 1-7 | Expressiveness + dev docs + **Research Agent impl.** |
| May 8-14 | Vision pipeline + **Capability Mapper impl.** |
| May 15-21 | Game polish + **Experience Designer impl.** |
| May 22-31 | **Engine Generator impl. + sandbox test** |
| June 1-7 | Education module + auth + **Agent workflow demo** |
| June 8-14 | Rate limiting + emergency features |
| June 15-21 | Multi-robot + load test |
| June 22-30 | Developer portal + booth prep |
| July 1-10 | Hardening + B2B materials + **Auto-gen refinement** |
| July 11-17 | Demo + follow-up |

---

*Plan Version: 1.2*  
*Updated: April 17, 2026*  
*Focus: AI-driven Experience Generation Platform*
