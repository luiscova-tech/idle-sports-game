// ============================================================
// src/sports/soccer/soccerModule.ts
// Soccer-specific implementation of SportModule<SoccerMatchState>. This is
// the only file allowed to say "goal", "chance", "possession", or "shot".
// ============================================================

import type { SportModule, TickResult, MatchOutcome, MatchContext } from '../../engine/types'

/** Soccer's opaque per-match state, as seen by the engine. */
export interface SoccerMatchState {
  homeScore: number
  awayScore: number
  elapsedTicks: number
}

/** Tunable soccer-specific rates. Widening this later with stat-driven
 *  fields (e.g. per-player contributions) never changes the tick() signature. */
export interface SoccerConfig {
  ticksPerMatch: number
  homeChancePerTick: number
  awayChancePerTick: number
  homeConversionRate: number
  awayConversionRate: number
}

export const DEFAULT_SOCCER_CONFIG: SoccerConfig = {
  ticksPerMatch: 90,
  homeChancePerTick: 0.08,
  awayChancePerTick: 0.07,
  homeConversionRate: 0.32,
  awayConversionRate: 0.26,
}

/** Tick interval, in milliseconds, tuned so a full match resolves in well
 *  under a couple of minutes of real time. */
export const SOCCER_TICK_INTERVAL_MS = 600

function createInitialState(): SoccerMatchState {
  return { homeScore: 0, awayScore: 0, elapsedTicks: 0 }
}

function tick(
  state: SoccerMatchState,
  tickIndex: number,
  config: SoccerConfig,
): TickResult<SoccerMatchState> {
  let { homeScore, awayScore } = state
  let scoringEvent = false

  // Home side: does a scoring chance occur this tick, and is it converted?
  if (Math.random() < config.homeChancePerTick) {
    if (Math.random() < config.homeConversionRate) {
      homeScore += 1
      scoringEvent = true
    }
  }

  // Away side: independent roll, same two-stage chance-then-conversion shape.
  if (Math.random() < config.awayChancePerTick) {
    if (Math.random() < config.awayConversionRate) {
      awayScore += 1
      scoringEvent = true
    }
  }

  return {
    state: {
      homeScore,
      awayScore,
      elapsedTicks: tickIndex + 1,
    },
    scoringEvent,
  }
}

function rawOutcomeOf(state: SoccerMatchState): MatchOutcome {
  if (state.homeScore > state.awayScore) return 'win'
  if (state.homeScore === state.awayScore) return 'draw'
  return 'loss'
}

/** Whether the raw outcome is a 'win' that context's minWinLevel gates
 *  away. Shared by getOutcome AND getPerformanceFactor below — they MUST
 *  agree on this, since a caller (economy.ts's calculateMatchRevenue) pairs
 *  up whatever the two return. An earlier version of this file computed the
 *  downgrade only inside getOutcome and left getPerformanceFactor reading
 *  the raw score unconditionally: a downgraded win (label 'draw') still
 *  reported its real, non-neutral goal-differential factor, so economy.ts's
 *  margin bonus — which is only ever supposed to apply to a genuine
 *  decisive win — leaked a bonus into what was actually paid out as a
 *  'draw'. Computing the gate once and feeding both functions from it makes
 *  that drift structurally impossible. */
function isGatedWin(rawOutcome: MatchOutcome, context?: MatchContext): boolean {
  return rawOutcome === 'win' && context?.minWinLevel !== undefined && (context.level ?? 0) < context.minWinLevel
}

/** Exported so UI can derive a live "if the match ended now" projected
 *  outcome from mid-match state, reusing the exact same logic the engine
 *  uses at actual match completion — never duplicated in a component.
 *
 *  `context` (optional — see MatchContext in engine/types.ts) supports the
 *  "minimum training level to win" mechanic: if the caller supplies
 *  `minWinLevel` and the current `level` falls short of it, a would-be win
 *  is downgraded to a draw — "trained enough to not lose, not enough to
 *  close it out." A raw draw/loss is never affected either way. Omitting
 *  context entirely (undefined) applies no gating at all, matching every
 *  other optional-capability rule in this codebase. */
export function getOutcome(state: SoccerMatchState, context?: MatchContext): MatchOutcome {
  const rawOutcome = rawOutcomeOf(state)
  return isGatedWin(rawOutcome, context) ? 'draw' : rawOutcome
}

/** The most meaningful goal differential for margin-bonus purposes — beyond
 *  this, an even bigger blowout doesn't add further bonus. Simulated against
 *  400k matches of the real tick probabilities above: P(|differential| >= 5)
 *  ~= 3.2%, and specifically P(a win by >= 5) ~= 2.7% — a real but genuinely
 *  rare "blowout" tail, not something an average match brushes up against
 *  (the median-ish differential band is 0-2). */
const MAX_MEANINGFUL_GOAL_DIFFERENTIAL = 5

/** Exported for the same drift-proof-preview reason as getOutcome above:
 *  economy.ts's margin bonus (see calculateMatchRevenue) only ever consumes
 *  this generic 0-1 number — 0 = most lopsided possible loss, 0.5 = neutral
 *  (any draw, regardless of score, sits exactly here since its differential
 *  is 0 by definition), 1 = most decisive possible win. Linear in the
 *  differential between the two clamped extremes.
 *
 *  `context` MUST be the same object passed to getOutcome() for the same
 *  state (see isGatedWin above) — when getOutcome would downgrade a win to
 *  a draw, this returns exactly 0.5 (neutral), the same factor a genuine
 *  draw reports, regardless of the real score. Without that, a downgraded
 *  win's real (non-neutral) differential would still feed economy.ts's
 *  margin bonus even though it's being paid out as a flat 'draw'. */
export function getPerformanceFactor(state: SoccerMatchState, context?: MatchContext): number {
  const rawOutcome = rawOutcomeOf(state)
  if (isGatedWin(rawOutcome, context)) return 0.5

  const diff = state.homeScore - state.awayScore
  const clamped = Math.max(
    -MAX_MEANINGFUL_GOAL_DIFFERENTIAL,
    Math.min(MAX_MEANINGFUL_GOAL_DIFFERENTIAL, diff),
  )
  return (clamped + MAX_MEANINGFUL_GOAL_DIFFERENTIAL) / (2 * MAX_MEANINGFUL_GOAL_DIFFERENTIAL)
}

export function createSoccerModule(
  config: SoccerConfig = DEFAULT_SOCCER_CONFIG,
): SportModule<SoccerMatchState> {
  return {
    id: 'soccer',
    ticksPerMatch: config.ticksPerMatch,
    createInitialState,
    tick: (state, tickIndex) => tick(state, tickIndex, config),
    getOutcome,
    getPerformanceFactor,
  }
}

/**
 * Soccer's venture tiers (Adventure-Capitalist-style parallel revenue
 * generators). Each tier runs its own independent match through the exact
 * same createSoccerModule()/tick()/getOutcome() above — the match
 * simulation itself never diverges per tier. The only per-tier difference
 * is a revenue multiplier applied on top of economy.ts's base win/draw/loss
 * payout, so src/engine/economy.ts stays untouched and tier-agnostic.
 *
 * Tier names/numbers are sport-specific vocabulary, so they live here (the
 * only file allowed to name soccer competition tiers) rather than in the
 * store. A second sport (step 3) defines its own tier list the same way.
 */
export interface SoccerVentureTierConfig {
  id: string
  name: string
  /** Placeholder tier art — a single emoji, standing in for real
   *  AI-generated icon/sprite art (step 9). Chosen to track this ladder's
   *  grounded -> epic -> absurd tone arc from tier 1 to tier 11. */
  icon: string
  /** Multiplier applied to economy.ts's base outcome revenue at upgrade level 1. */
  baseRevenueMultiplier: number
  /** Revenue cost to unlock this tier, paid from the player's current
   *  spendable balance (same pool as Improve Training/Hire a Manager) —
   *  a deliberate player choice, not an automatic threshold. Ignored for
   *  the first tier, which starts unlocked. */
  unlockCost: number
  /** One-time Revenue cost to unlock auto-play for this tier. */
  managerHireCost: number
  /** Cost of this tier's first "Improve Training" upgrade (level 1 -> 2). */
  upgradeBaseCost: number
  /** Per-level cost growth rate — a mild exponential curve. */
  upgradeCostGrowth: number
}

export const SOCCER_VENTURE_TIERS: SoccerVentureTierConfig[] = [
  {
    id: 'local-game',
    name: 'The Sunday League',
    icon: '⚽',
    baseRevenueMultiplier: 1,
    unlockCost: 0,
    managerHireCost: 150,
    upgradeBaseCost: 100,
    upgradeCostGrowth: 1.6,
  },
  {
    id: 'local-tournament',
    name: 'The Corner Kick Cup',
    icon: '🚩',
    baseRevenueMultiplier: 4,
    unlockCost: 450,
    managerHireCost: 500,
    upgradeBaseCost: 300,
    upgradeCostGrowth: 1.6,
  },
  {
    id: 'regional-championship',
    name: 'The Regional Rumble',
    icon: '🥉',
    baseRevenueMultiplier: 12,
    unlockCost: 2250,
    managerHireCost: 2500,
    upgradeBaseCost: 1200,
    upgradeCostGrowth: 1.65,
  },
  {
    id: 'national-league',
    name: 'The National Cup',
    icon: '🏅',
    baseRevenueMultiplier: 35,
    unlockCost: 11250,
    managerHireCost: 12000,
    upgradeBaseCost: 5000,
    upgradeCostGrowth: 1.7,
  },
  {
    id: 'continental-cup',
    name: 'The Continental Clash',
    icon: '🌍',
    baseRevenueMultiplier: 100,
    unlockCost: 56250,
    managerHireCost: 60000,
    upgradeBaseCost: 21000,
    upgradeCostGrowth: 1.75,
  },
  {
    id: 'world-championship',
    name: 'The World Crown',
    icon: '👑',
    baseRevenueMultiplier: 280,
    unlockCost: 281250,
    managerHireCost: 300000,
    upgradeBaseCost: 88200,
    upgradeCostGrowth: 1.8,
  },
  // Tiers 7-11, added once "Reset for Legacy" existed (see CLAUDE.md
  // "Prestige system" / "Post-prestige ladder"). Mechanical continuation of
  // the exact tier 1-6 curve — same 5x unlock/manager-cost growth, same
  // ~4.2x upgrade-base-cost growth, same +0.05-per-tier upgradeCostGrowth,
  // same gently-decreasing baseRevenueMultiplier ratio (2.8 -> 2.75 -> 2.70
  // -> 2.65 -> 2.60 -> 2.55) — no new balance philosophy introduced. These
  // stay invisible in the UI (see revealedTierCount below) until revealed
  // one at a time by successive prestiges, per that mechanic's design.
  {
    id: 'legends-circuit',
    name: "The Legends' Gauntlet",
    icon: '⚔️',
    baseRevenueMultiplier: 770,
    unlockCost: 1406250,
    managerHireCost: 1500000,
    upgradeBaseCost: 370440,
    upgradeCostGrowth: 1.85,
  },
  {
    id: 'galactic-league',
    name: 'The Interstellar Invitational',
    icon: '🚀',
    baseRevenueMultiplier: 2079,
    unlockCost: 7031250,
    managerHireCost: 7500000,
    upgradeBaseCost: 1555848,
    upgradeCostGrowth: 1.9,
  },
  {
    id: 'mythic-ascension',
    name: 'The Mythic Ascension',
    icon: '🐉',
    baseRevenueMultiplier: 5509,
    unlockCost: 35156250,
    managerHireCost: 37500000,
    upgradeBaseCost: 6534562,
    upgradeCostGrowth: 1.95,
  },
  {
    id: 'eternal-championship',
    name: 'The Eternal Crown',
    icon: '♾️',
    baseRevenueMultiplier: 14323,
    unlockCost: 175781250,
    managerHireCost: 187500000,
    upgradeBaseCost: 27445160,
    upgradeCostGrowth: 2.0,
  },
  {
    id: 'multiverse-cup',
    name: 'The Multiverse Cup',
    icon: '🌌',
    baseRevenueMultiplier: 36524,
    unlockCost: 878906250,
    managerHireCost: 937500000,
    upgradeBaseCost: 115269672,
    upgradeCostGrowth: 2.05,
  },
]

/** The tier whose unlock gates the FIRST "Reset for Legacy" — i.e. the
 *  original ladder's final tier. Looked up by id, deliberately NOT by
 *  `tiers[tiers.length - 1]`: once tiers 7-11 exist in this array, "the
 *  last tier" is The Multiverse Cup, which a player can only reach AFTER
 *  already prestiging once — checking by array-position would make a first
 *  prestige permanently impossible. This id-based constant is the fix, and
 *  stays correct no matter how many more tiers get appended later. */
export const FIRST_PRESTIGE_TRIGGER_TIER_ID = 'world-championship'

/** How many tiers (from the front of SOCCER_VENTURE_TIERS) are visible from
 *  the very start, before any prestige. Derived from
 *  FIRST_PRESTIGE_TRIGGER_TIER_ID rather than a second hand-maintained
 *  number, so the reveal boundary and the prestige-trigger tier can never
 *  silently drift apart. */
export const TIERS_REVEALED_AT_START =
  SOCCER_VENTURE_TIERS.findIndex((c) => c.id === FIRST_PRESTIGE_TRIGGER_TIER_ID) + 1

/** How many of tiers 7-11 (legends-circuit onward) CAN ever be revealed by
 *  prestiging — exactly the remainder of the ladder past the starting
 *  reveal boundary. Kept as its own constant (rather than a hardcoded 5) so
 *  it stays correct if the ladder is ever extended further. */
export const MAX_POST_PRESTIGE_REVEALS = SOCCER_VENTURE_TIERS.length - TIERS_REVEALED_AT_START

/**
 * How many tiers (from the front of SOCCER_VENTURE_TIERS) are visible given
 * a player's current `prestigeCount`. Supersedes the original "all of tiers
 * 7-11 reveal at once on first prestige" behavior — now exactly ONE
 * additional hidden tier reveals per COMPLETED prestige (tier 7 after
 * prestige #1, tier 8 after #2, ... tier 11 after #5), and reveals stop
 * there: `Math.min(prestigeCount, MAX_POST_PRESTIGE_REVEALS)` caps the bonus
 * at 5 regardless of how many further times a player prestiges. There is no
 * minimum time/earnings gate on top of this — a player who prestiges in
 * rapid succession reveals tiers just as fast; that's an accepted trade-off
 * (they're also giving up more mid-run progress each time to do it), not
 * something this function tries to prevent. */
export function revealedTierCount(prestigeCount: number): number {
  return TIERS_REVEALED_AT_START + Math.min(prestigeCount, MAX_POST_PRESTIGE_REVEALS)
}

/** Whether the tier at `tierIndex` is allowed to exist/be interacted with
 *  right now, given the current `prestigeCount`. This is the single
 *  authoritative check for the reveal boundary — every store action that
 *  touches a tier (tick/upgrade/hire manager/unlock) calls this, not just
 *  Home.tsx's render slice, so a not-yet-revealed tier can't be made to earn
 *  real Revenue (e.g. via a hand-edited localStorage save flipping
 *  `unlocked` directly) before it's actually been revealed. */
export function isTierRevealed(tierIndex: number, prestigeCount: number): boolean {
  return tierIndex < revealedTierCount(prestigeCount)
}

/** Revenue cost to raise a tier currently at `currentLevel` to the next level. */
export function tierUpgradeCost(config: SoccerVentureTierConfig, currentLevel: number): number {
  return Math.round(config.upgradeBaseCost * config.upgradeCostGrowth ** (currentLevel - 1))
}

/**
 * Compounding-doubling "Improve Training" milestones. Crossing a level in
 * this list DOUBLES the cumulative training effect from that point forward
 * (stacking: crossing N milestones multiplies by 2^N) — not a flat lookup
 * table, an actual running multiplier, so the boost from an earlier
 * milestone is still there when a later one is crossed.
 *
 * Levels (and their widening gaps: 7, 9, 12, 16, 20, 25, 30, 35, 40) were
 * derived by simulating this game's REAL per-tier cost/revenue curves (see
 * CLAUDE.md "Milestone multipliers" for the full derivation), not chosen as
 * round numbers: without any milestone boost, this economy's exponential
 * upgradeCostGrowth (1.6-2.05x per level) against linear-in-level revenue
 * means the level-up cadence itself grows ~g times slower every level, so a
 * fixed absolute level number becomes many-days-then-effectively-unreachable
 * within a few dozen levels at every tier, regardless of that tier's own
 * baseRevenueMultiplier (which only shifts the wall by a few levels, since
 * it's a constant factor against an exponential). The doubling exists
 * specifically to keep pushing that wall back out. Early milestones (6, 13,
 * 22) land within single-digit minutes to about an hour of dedicated
 * training investment at any tier; by design (matching Cookie Clicker's own
 * high-count building milestones) the later ones (125+) are long-horizon,
 * many-real-days goals for only the most dedicated single-tier grinding —
 * not something an average session is expected to reach. */
export const TRAINING_MILESTONE_LEVELS = [6, 13, 22, 34, 50, 70, 95, 125, 160, 200]

/** The actual training-driven revenue multiplier at a given "Improve
 *  Training" level — `level` scaled linearly as before, times 2 for every
 *  milestone in TRAINING_MILESTONE_LEVELS that level has reached or passed.
 *  Used everywhere a tier's level currently scales revenue (per-tick,
 *  match-completion bonus) — see tierPerTickRevenue below and
 *  useGameStore.ts's completion-bonus calculation. Does NOT affect
 *  tierUpgradeCost, which stays keyed on the raw level exactly as before —
 *  only the revenue side of training gets the milestone boost. */
export function trainingEffectMultiplier(level: number): number {
  let milestonesPassed = 0
  for (const milestone of TRAINING_MILESTONE_LEVELS) {
    if (level >= milestone) milestonesPassed += 1
  }
  return level * 2 ** milestonesPassed
}

/**
 * Minimum "Improve Training" level required before a 'win' outcome is
 * achievable at this tier at all (see getOutcome's `context.minWinLevel` in
 * this file, and MatchContext in engine/types.ts) — below it, only
 * draw/loss can occur, full stop, no partial win chance. A flat `tierIndex +
 * 1` (1 for tier 0, escalating by exactly one level per tier, capping at 11
 * for The Multiverse Cup): simulated against the same real cost/revenue
 * curves used for the milestones above, this keeps every tier's very first
 * possible win within single-digit-minutes of dedicated manual play at the
 * low tiers, and a genuine but never-impossible few-hours-to-low-single-
 * digit-days investment at the very top tier (The Multiverse Cup, level 11)
 * — steeper escalation (e.g. doubling per tier) was tried and rejected
 * during simulation because this economy's exponential per-level cost
 * growth makes even level ~20-30 already many-days-to-unreachable at the
 * top tiers, which would make a top tier's win outcome effectively
 * impossible forever — the opposite of the intended "escalating but always
 * eventually achievable" gate. */
export function minWinLevelForTier(tierIndex: number): number {
  return tierIndex + 1
}

/** Real-world milliseconds between auto-play ticks for the tier at
 *  `tierIndex` — ONLY consumed by the idle auto-tick interval
 *  (useMatchTicker.ts); a manual "Push the Attack" click always resolves a
 *  tick instantly regardless of tier, by construction (it calls tickTier()
 *  directly, never through this interval). Match length stays a fixed 90
 *  ticks at every tier (unchanged) — this only stretches how long an
 *  automated manager takes to grind through those 90 ticks. Geometric
 *  growth from the pre-existing 600ms base (tier 0's pacing is completely
 *  unchanged from before this session, preserving all of its prior
 *  playtesting/balance), at a fixed 1.4x per tier: tier 0 stays a ~54s
 *  auto-match, climbing to a ~26-minute auto-match at tier 10 (The
 *  Multiverse Cup) — a ~29x spread top to bottom. Chosen so the highest
 *  tiers feel meaningfully more "epic"/slow on auto-play (rewarding active
 *  manual clicking, or patience) without making any tier's automation take
 *  implausibly long (hours+) per match. */
export const BASE_AUTO_TICK_INTERVAL_MS = SOCCER_TICK_INTERVAL_MS
const AUTO_TICK_INTERVAL_GROWTH_PER_TIER = 1.4

export function autoTickIntervalMsForTier(tierIndex: number): number {
  return Math.round(BASE_AUTO_TICK_INTERVAL_MS * AUTO_TICK_INTERVAL_GROWTH_PER_TIER ** tierIndex)
}

/** Base direct Revenue granted per tick (manual click or automated) at
 *  multiplier=1, level=1, before tier/level scaling. Tuned so a brand-new
 *  Local Game player reaches their first affordable purchase (Improve
 *  Training, cost 100) in ~25s at an assumed 1 click/sec manual pace. */
export const BASE_PER_TICK_REVENUE = 4

/** Direct Revenue granted for a single tick at this tier/level — the
 *  "clicking is the primary generator" amount, added every tick (manual or
 *  auto) on top of the existing match-completion bonus. Scales by the same
 *  baseRevenueMultiplier * trainingEffectMultiplier(level) factor the
 *  completion bonus already uses (see useGameStore.ts), so relative
 *  tier/level progression — including milestone doublings — stays
 *  consistent between the two. */
export function tierPerTickRevenue(config: SoccerVentureTierConfig, level: number): number {
  return Math.round(BASE_PER_TICK_REVENUE * config.baseRevenueMultiplier * trainingEffectMultiplier(level))
}
