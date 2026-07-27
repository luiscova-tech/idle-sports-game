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
- The idle loop's `setInterval` lives in exactly one place — a React hook (`src/hooks/useMatchTicker.ts`). The engine, economy, and store stay fully timer-free and synchronously testable; the hook takes `intervalMs` as a parameter so future sports can supply their own pacing.
- The Zustand store (`src/store/useGameStore.ts`) instantiates one module-scoped sport module (currently `createSoccerModule()`), reused identically by every venture tier (see below) — never forked or reconfigured per tier.

### Manual-before-automated pattern (amendment to step 2)
Classic idle games hook players with manual interaction before automation is earned. Applied to soccer, and intended as the template for every future sport:
- A single per-tier resolution path (`tickTier(tierId)` in the store) advances that tier's match by one tick — it is called identically by the idle interval and by a manual player tap, so there is never a forked "manual" vs. "automatic" simulation branch.
- Each tier has its own `managerHired` boolean (default `false`) gating its own automation: `useMatchTicker` only auto-ticks tiers where `unlocked && managerHired` are both true. Before that, a tier only advances via its own manual "Push the Attack" button.
- `managerHired` is flipped by a one-time per-tier Revenue purchase (`hireManagerForTier(tierId)`, cost from that tier's config). This cost/unlock logic lives in the store/sport-module layer, not in `src/engine/economy.ts` — it's an idle mechanic ("pay currency to unlock automation"), not part of the sport-agnostic match-outcome economy.
- Chosen design: the manual action button stays visible and usable even after automation unlocks (a supplemental boost), rather than being hidden — matches the genre convention that active play keeps some value after idle progression is unlocked.
- Future sports should follow the same shape: a manual per-tick trigger wired to the same tick-resolution path, gated automation behind a purchasable unlock, no changes to `src/engine/**`.

### Venture tiers (second amendment to step 2 — Adventure-Capitalist-style restructuring)
The single global match view was replaced with a vertical stack of independent "venture tier" cards (`Local Game → Local Tournament → Regional Championship → National League` for soccer), each its own parallel revenue generator:
- **Reuse vs. divergence:** every tier runs its match through the exact same `createSoccerModule()` instance and the exact same `advanceTick`/`isMatchComplete`/`finalizeMatch` (`src/engine/tickEngine.ts`) and `calculateMatchRevenue` (`src/engine/economy.ts`) — none of those files changed. The only per-tier divergence is a revenue multiplier (`baseRevenueMultiplier × level`) applied in the store, in `tickTier()`, on top of `economy.ts`'s base win/draw/loss payout. `economy.ts` itself has no concept of tiers.
- Tier names/multipliers/costs are sport-specific vocabulary, so they live in `src/sports/soccer/soccerModule.ts` (`SOCCER_VENTURE_TIERS`, `tierUpgradeCost()`) — the same file that owns "goal"/"chance"/etc. A second sport (step 3) defines its own tier list the same way.
- **Store shape:** `useGameStore.ts` now holds `tiers: VentureTier[]` (id, unlocked, level, managerHired, tickIndex, match, matchesCompleted, cumulativeRevenue, lastOutcome) instead of one global match object, plus the store-level actions `tickTier`, `upgradeTier` ("Improve Training" — raises `level`, cost grows per level via a mild exponential curve), and `hireManagerForTier`.
- ~~**Unlock-threshold logic chosen:** a locked tier unlocks once the immediately preceding tier's `cumulativeRevenue`... reaches a configured threshold, auto-checked every tick.~~ **Superseded** — see "Tier unlocking as a player purchase" below; unlocking is now a deliberate spend from the current Revenue balance, not an automatic threshold.
- Revenue stays ONE global currency (`currencies.revenue`), spent/earned by every tier — `cumulativeRevenue` is a per-tier informational stat (lifetime Revenue earned from that tier), not a second currency. This preserves the currency-separation principle above.
- UI: `src/components/VentureCard.tsx` (one per tier, mapped from the static `SOCCER_VENTURE_TIERS` config in `src/routes/Home.tsx`) replaced the old single `MatchPanel`/`MatchControls`, which were deleted. No styling pass yet (that's step 9) — just structure/interactivity.

### Payout visibility fix (third amendment to step 2)
Closed the "click with no feedback until match end" gap identified in playtesting: `VentureCard.tsx` now derives a live match-progress percentage (a native `<progress>` element) from `elapsedTicks / DEFAULT_SOCCER_CONFIG.ticksPerMatch`, and a live "if the match ended now" projected-payout line. The projection reuses `getOutcome()` (now exported from `soccerModule.ts`) and `calculateMatchRevenue()` (`src/engine/economy.ts`) — the exact same functions the store calls at real match completion — so the preview can never drift out of sync with the actual payout. Purely presentational at the time it was made; superseded below by an actual economy change (Revenue is no longer only credited at completion).

### Persistence (transparent addition to step 2)
`src/store/useGameStore.ts` is now wrapped in zustand's `persist` middleware (localStorage, key `idle-sports-game-save`), per the "client-side persistence for v1" tech-stack line. `partialize` persists only `{ tiers, currencies }` — actions are always recreated fresh, never serialized. This is transparent to every tier/economy/engine call site above; none of that code changed.

### Direct-click economy model (fourth amendment to step 2 — supersedes "pay at outcome only")
Manual clicks (and equivalently automated ticks — same `tickTier()` path, no fork) now grant direct, immediate Revenue every tick. The match-completion payout is no longer the only source of Revenue; it's an additional bonus stacked on top:
- `src/sports/soccer/soccerModule.ts` adds `BASE_PER_TICK_REVENUE = 4` and `tierPerTickRevenue(config, level)` (`round(BASE_PER_TICK_REVENUE * baseRevenueMultiplier * level)`) to its additive tier-config section — the same scaling factor the completion bonus already uses, so relative tier/level progression stays consistent between the two income sources. `tick()`, `getOutcome()`, `DEFAULT_SOCCER_CONFIG`, and `createSoccerModule()` are unchanged.
- `tickTier()` in the store now adds `perTickRevenue` to both `currencies.revenue` and that tier's `cumulativeRevenue` on **every** tick, not only at completion. On the completion tick, the unchanged completion-bonus formula is added on top (`totalEarned = perTickRevenue + completionBonus`), never replacing it. (`cumulativeRevenue` still accrues every tick as a per-tier informational stat, but — as of the fifth amendment below — no longer drives unlocking.)
- **Balancing reasoning:** assumed 1 click/sec (a conservative, easily-sustained manual pace, slower than the game's own 600ms auto-tick rate). At `BASE_PER_TICK_REVENUE=4`, Local Game/level 1 earns 4 Revenue/tick, so the cheapest first purchase (Improve Training, cost 100) is reachable in `100/4 = 25` ticks ≈ 25s — the middle of the requested 20-30s window.
- **Threshold numbers chosen (originally as auto-unlock thresholds, now reused as unlock purchase costs — see below):** `local-tournament` 600→450, `regional-championship` 3000→2250, `national-league` 15000→11250 (`local-game`'s is unused). The 450→2250→11250 ladder is a clean 5x/5x growth, preserving the pre-existing design intent that unlock costs compound faster than the (unchanged, ~4x/3x/2.9x) multiplier growth per tier.
- UI: both purchase buttons show a clamped "current/cost Revenue" progress format (e.g. `Improve Training (72/100 Revenue)`, capped at the cost once affordable) instead of a flat cost, and a `+N Revenue per push` caption sits under "Push the Attack", computed via the same `tierPerTickRevenue()` helper `tickTier()` uses — never a separate hardcoded number.
- Playtested end-to-end: first Revenue is now visible after exactly one click (previously required a full 90-tick match); the first affordable purchase (Improve Training) now lands at click/second 25 (previously took multiple full matches, hundreds of clicks).

### Tier unlocking as a player purchase (fifth amendment to step 2 — supersedes automatic threshold-unlock)
Unlocking a tier is now a deliberate spend, not something that fires automatically once a stat crosses a threshold:
- `SoccerVentureTierConfig`'s `unlockThreshold` field is renamed `unlockCost` — it's paid from the player's current spendable `currencies.revenue` balance, the exact same pool `upgradeTier`/`hireManagerForTier` draw from. The three cost values are unchanged (450 / 2250 / 11250) — only the trigger mechanism changed, per this amendment's request.
- New store action `unlockTier(tierId)`: no-op if already unlocked or Revenue is insufficient; otherwise deducts `unlockCost` and flips that tier's `unlocked` to `true`. Same shape as `upgradeTier`/`hireManagerForTier` — no new pattern introduced.
- `applyTierUnlocks` (the old every-tick auto-check function) is deleted entirely — `tickTier()` no longer touches unlock state at all, only match/revenue state.
- UI: a locked tier's card now shows an always-rendered "Unlock {name} ({current}/{cost} Revenue)" button, disabled until affordable — identical pattern to the Improve Training/Hire a Manager buttons, rather than a passive progress readout.
- **This is the intended design:** because unlock cost is drawn from the same balance as every other purchase, spending on the current tier directly delays affording the next tier's unlock, and vice versa — a real, felt trade-off, not just numbers on two independent tracks. Playtested and confirmed: buying Local Game's "Improve Training" at Revenue=100 visibly reset "Unlock Local Tournament" progress from 100/450 back to 0/450 in the same instant; later, spending 450 to unlock Local Tournament at Revenue=456 instantly dropped Local Game's own Improve Training/Hire a Manager buttons from affordable back to disabled. Both directions of the tension are directly observable, not theoretical.

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
- Solo git workflow: commit directly to `main` for all build-order steps. Do not create feature branches or open pull requests unless explicitly asked.
- End-of-session deliverables: every session ends with (1) a written summary of what was done, (2) a plain-text description of the current UI state as observed via the browser preview tool (what's rendered, what changed visually) — even without a screenshot, so the user can relay it to another reviewer — and (3) a playable link (start the dev server via the browser preview tool and give the `http://localhost:5173` URL, noting it's local-only and stops when the session ends).

## Maintenance
After any session that completes a meaningful chunk of work (a full build-order step, a significant architecture decision, or a notable deviation from the plan above), **regenerate this file**: update the checkboxes, add any new conventions or architecture decisions actually made, and note deviations from the original brief. Keep it concise — this file should always reflect current reality, not the full history of how it got there.
