# CLAUDE.md — Idle Sports Franchise Builder

This file is read automatically at the start of every Claude Code session in this repo. Keep it current — see "Maintenance" at the bottom.

## Project Summary
A multi-sport idle/incremental franchise management game. Browser-first (React + Vite), with a planned later wrap for iOS via Capacitor. Full design brief: see `idle-sports-game-brief.md` in repo root.

## Tech Stack
- React + Vite (TypeScript template)
- Zustand for game state (single central store)
- react-router-dom for routing
- Client-side persistence only for v1 (localStorage/IndexedDB) — no backend
- 2D flat icon/sprite art for v1 (AI-generated, style-locked prompts)

## Architecture Principles
- **One shared engine, not per-sport systems.** Core engine (match sim, economy, player model, facilities, season/standings, prestige, events) is sport-agnostic. Sport-specific rules (stat weights, scoring, roster size) live in plugged-in sport modules.
- **Currency types are separated in the data model from day one** (even premium/future currency fields), so monetization can be added later without a rewrite.
- **v1 ships with exactly 2 sports.** Do not add a 3rd sport until the shared engine has been validated with 2 working end-to-end.
- Keep save/economy logic isolated in its own module — not scattered across UI components.

### Engine / sport-module split (established in step 2)
- `src/engine/types.ts` defines the sport-agnostic contract: `MatchOutcome` ('win'/'draw'/'loss'), `TickResult<TState>`, `MatchResult<TState>`, and the `SportModule<TState>` interface (`id`, `ticksPerMatch`, `createInitialState()`, `tick(state, tickIndex)`, `getOutcome(state)`). `TState` is fully opaque to the engine — sport modules own their own state shape.
- `src/engine/tickEngine.ts` holds three pure, timer-free helper functions (`advanceTick`, `isMatchComplete`, `finalizeMatch`) that operate generically over any `SportModule<TState>`. It must never import from `src/sports/**` or reference sport-specific vocabulary.
- `src/engine/economy.ts` is the single isolated home for currency math — a `REVENUE_BY_OUTCOME` table keyed only on the generic `MatchOutcome`, shared by every sport rather than redefined per sport.
- A sport plugs in by implementing `SportModule<TState>` in its own folder under `src/sports/<sport>/` (see `src/sports/soccer/soccerModule.ts`) — that's the only place sport-specific vocabulary (goals, possession, shots, etc.) is allowed to appear.
- The idle loop's `setInterval` lives in exactly one place — a React hook (`src/hooks/useMatchTicker.ts`) that calls the store's `tick()` action on an interval. The engine, economy, and store stay fully timer-free and synchronously testable; the hook takes `intervalMs` as a parameter so future sports can supply their own pacing.
- The Zustand store (`src/store/useGameStore.ts`) instantiates one module-scoped sport module (currently `createSoccerModule()`) and exposes a single `tick()` action; on match completion it resets match state in the same `set()` call, which is what makes the loop self-perpetuating (no separate "start next match" action needed).

## Build Order (current status — update the checkboxes as work completes)
- [x] 1. Scaffold React/Vite + Zustand, basic layout, empty store
- [x] 2. Single-sport match-sim tick loop, one currency, minimal UI
- [ ] 3. Second sport as a plugged-in module (validates engine abstraction)
- [ ] 4. Player development, scouting, contracts
- [ ] 5. Facilities/upgrades system
- [ ] 6. Season structure, standings, promotion/relegation
- [ ] 7. Prestige / Franchise Legacy reset system
- [ ] 8. Invitational Games event system
- [ ] 9. UI polish + integrate final art assets
- [ ] 10. Capacitor wrap for iOS

## Out of Scope for v1
- Multiplayer / leaderboards
- More than 2 sports
- Backend/server
- Monetization/IAP implementation (architecture should allow it; don't build it)
- Rich illustrated art (2D icons only)

## Conventions
- Scoped sessions: work one build-order step at a time. Stop and summarize before starting the next step unless explicitly told to continue.
- Prefer clarity/maintainability over premature optimization — this is a solo long-term project, not a performance-critical app.

## Maintenance
After any session that completes a meaningful chunk of work (a full build-order step, a significant architecture decision, or a notable deviation from the plan above), **regenerate this file**: update the checkboxes, add any new conventions or architecture decisions actually made, and note deviations from the original brief. Keep it concise — this file should always reflect current reality, not the full history of how it got there.
