// ============================================================
// src/engine/ventureTiers.ts
// Sport-agnostic "venture tier" mechanics — the Adventure-Capitalist-style
// parallel-revenue-generator math shared by every sport's ladder (see
// CLAUDE.md's "Venture tiers" amendment). None of this file knows what a
// "goal" or an "at-bat" is; it only ever consumes a generic tier config
// (cost/multiplier numbers) and a generic training level. Hoisted out of
// src/sports/soccer/soccerModule.ts when baseball needed the exact same
// tier-cost/revenue/pacing formulas — this project has a real, repeated bug
// history from duplicated math silently drifting apart, so a second sport
// reuses this instead of reimplementing byte-identical formulas under a new
// name.
// ============================================================

import type { SportModule, MatchContext, MatchOutcome } from './types'
import { advanceTick, isMatchComplete, finalizeMatch } from './tickEngine'

/**
 * A venture tier's static configuration — cost/multiplier numbers only,
 * nothing sport-specific. Every sport's own tier list (SOCCER_VENTURE_TIERS,
 * BASEBALL_VENTURE_TIERS, ...) is typed against this same shared shape,
 * plus whatever sport-specific display fields it wants to add (name/icon
 * live directly on this shape already, since every sport needs them).
 */
export interface VentureTierConfig {
  id: string
  name: string
  /** Placeholder tier art — a single emoji, standing in for real
   *  AI-generated icon/sprite art (step 9). */
  icon: string
  /** Multiplier applied to economy.ts's base outcome revenue at upgrade level 1. */
  baseRevenueMultiplier: number
  /** Revenue cost to unlock this tier, paid from the player's current
   *  spendable balance. Ignored for a sport's first tier if it starts
   *  unlocked (see that sport's own createInitialTiers-equivalent). */
  unlockCost: number
  /** One-time Revenue cost to unlock auto-play for this tier. */
  managerHireCost: number
  /** Cost of this tier's first "Improve Training" upgrade (level 1 -> 2). */
  upgradeBaseCost: number
  /** Per-level cost growth rate — a mild exponential curve. */
  upgradeCostGrowth: number
}

/** The state every venture tier tracks in the store, generic over that
 *  sport's own opaque match-state shape. Soccer's `VentureTier` and
 *  baseball's `BaseballVentureTier` are both just this type applied to
 *  their own TState — the SHAPE of tier progress (level, manager, matches
 *  completed, cumulative revenue, last outcome) has nothing sport-specific
 *  about it either. */
export interface VentureTierState<TState> {
  id: string
  unlocked: boolean
  /** "Improve Training" level — raises this tier's revenue multiplier. */
  level: number
  managerHired: boolean
  tickIndex: number
  match: TState
  matchesCompleted: number
  /** Lifetime Revenue earned FROM this tier specifically — an informational
   *  stat only; Revenue itself stays one global pool. */
  cumulativeRevenue: number
  lastOutcome: MatchOutcome | null
}

/** Revenue cost to raise a tier currently at `currentLevel` to the next level. */
export function tierUpgradeCost(config: VentureTierConfig, currentLevel: number): number {
  return Math.round(config.upgradeBaseCost * config.upgradeCostGrowth ** (currentLevel - 1))
}

/**
 * Compounding-doubling "Improve Training" milestones. Crossing a level in
 * this list DOUBLES the cumulative training effect from that point forward
 * (stacking: crossing N milestones multiplies by 2^N). Levels were derived
 * by simulating SOCCER's real per-tier cost/revenue curves (see CLAUDE.md
 * "Milestone multipliers") — reused as-is for baseball's validation-slice
 * tiers too, since baseball's own tier costs were deliberately calibrated
 * to be roughly proportionate to soccer's (see CLAUDE.md's "Baseball"
 * amendment); a future full baseball ladder may warrant re-deriving these
 * against baseball's own eventual full cost curve instead. */
export const TRAINING_MILESTONE_LEVELS = [6, 13, 22, 34, 50, 70, 95, 125, 160, 200]

/** The actual training-driven revenue multiplier at a given "Improve
 *  Training" level — `level` scaled linearly, times 2 for every milestone
 *  in TRAINING_MILESTONE_LEVELS that level has reached or passed. Does NOT
 *  affect tierUpgradeCost, which stays keyed on the raw level. */
export function trainingEffectMultiplier(level: number): number {
  let milestonesPassed = 0
  for (const milestone of TRAINING_MILESTONE_LEVELS) {
    if (level >= milestone) milestonesPassed += 1
  }
  return level * 2 ** milestonesPassed
}

/** The next not-yet-reached milestone level above `level`, or `null` once
 *  every milestone has been passed. */
export function nextMilestoneLevel(level: number): number | null {
  return TRAINING_MILESTONE_LEVELS.find((milestone) => level < milestone) ?? null
}

/** The largest already-crossed milestone at or below `level`, or `1` if
 *  none have been crossed yet — pairs with nextMilestoneLevel so the UI can
 *  show progress SINCE the previous milestone rather than a raw level over
 *  the next one (which is misleadingly pre-filled right after any crossing
 *  after the very first). */
export function previousMilestoneLevel(level: number): number {
  let previous = 1
  for (const milestone of TRAINING_MILESTONE_LEVELS) {
    if (level >= milestone) previous = milestone
  }
  return previous
}

/** Base direct Revenue granted per tick (manual click or automated) at
 *  multiplier=1, level=1, before tier/level scaling. Tuned so a brand-new
 *  player reaches their first affordable purchase in roughly 20-30s at an
 *  assumed 1 click/sec manual pace. */
export const BASE_PER_TICK_REVENUE = 4

/** Direct Revenue granted for a single tick at this tier/level — the
 *  "clicking (or one at-bat, one possession, whatever a tick means for
 *  this sport) is the primary generator" amount, added every tick (manual
 *  or auto) on top of the match-completion bonus. */
export function tierPerTickRevenue(config: VentureTierConfig, level: number): number {
  return Math.round(BASE_PER_TICK_REVENUE * config.baseRevenueMultiplier * trainingEffectMultiplier(level))
}

/**
 * The [min, max] level range this tier's per-match opponent is drawn from,
 * centered on `tierIndex + 1` with a fixed ±2 spread clamped at a floor of
 * 1 — every match draws a slightly different opponent, and even a
 * just-reached tier (level 1) has a real, nonzero chance to win
 * immediately, with odds smoothly improving as training catches up to the
 * range's center. Generic over any sport's own 0-indexed tier list. */
export function opponentLevelRangeForTier(tierIndex: number): { min: number; max: number } {
  const center = tierIndex + 1
  return { min: Math.max(1, center - 2), max: center + 2 }
}

/** Real-world milliseconds between auto-play ticks for the tier at
 *  `tierIndex` (within that sport's OWN tier list) — ONLY consumed by the
 *  idle auto-tick interval; a manual click always resolves a tick
 *  instantly regardless of tier. Geometric growth at a fixed 1.4x per tier
 *  from a 600ms base, so the highest tiers feel meaningfully more "epic"/
 *  slow on auto-play without making any tier's automation take implausibly
 *  long per match. */
export const BASE_AUTO_TICK_INTERVAL_MS = 600
const AUTO_TICK_INTERVAL_GROWTH_PER_TIER = 1.4

export function autoTickIntervalMsForTier(tierIndex: number): number {
  return Math.round(BASE_AUTO_TICK_INTERVAL_MS * AUTO_TICK_INTERVAL_GROWTH_PER_TIER ** tierIndex)
}

/** Result of resolving one venture-tier tick — everything a store action
 *  needs to fold into its own `set()` call, generic over the sport. */
export interface VentureTierTickResult<TState> {
  nextMatch: TState
  nextTickIndex: number
  perTickRevenue: number
  completed: boolean
  outcome?: MatchOutcome
  completionBonus?: number
}

/**
 * The single shared "advance one venture tier by one tick" resolution,
 * used by every sport's own tickTier-equivalent store action. Composes
 * tickEngine.ts's generic advanceTick/isMatchComplete/finalizeMatch with
 * this file's own per-tick/completion-bonus revenue formulas — this is
 * exactly the ECONOMIC logic (not just the raw win-probability formula)
 * this project's bug history warns against duplicating, so it exists here
 * once, called by every sport, rather than being re-derived per sport
 * module. Pure: takes everything it needs as arguments, returns a plain
 * result object — no store/React coupling, so each sport's own store
 * action just applies this result to its own tiers array via its own
 * `set()` call (which currency bucket, which array — the one piece of
 * genuinely per-sport plumbing this does NOT attempt to unify, since it's
 * thin, low-risk, and mechanical rather than economic).
 */
export function resolveVentureTierTick<TState>(
  module: SportModule<TState>,
  tier: { level: number; match: TState; tickIndex: number },
  matchContext: MatchContext | undefined,
  config: VentureTierConfig,
  legacyMultiplier: number,
): VentureTierTickResult<TState> {
  const { state: nextMatch } = advanceTick(module, tier.match, tier.tickIndex, matchContext)
  const nextTickIndex = tier.tickIndex + 1
  const perTickRevenue = Math.round(tierPerTickRevenue(config, tier.level) * legacyMultiplier)

  if (isMatchComplete(module, nextTickIndex, nextMatch)) {
    const { outcome, revenue: baseRevenue } = finalizeMatch(module, nextMatch, matchContext)
    const completionBonus = Math.round(
      baseRevenue * config.baseRevenueMultiplier * trainingEffectMultiplier(tier.level) * legacyMultiplier,
    )
    return {
      nextMatch: module.createInitialState(),
      nextTickIndex: 0,
      perTickRevenue,
      completed: true,
      outcome,
      completionBonus,
    }
  }

  return { nextMatch, nextTickIndex, perTickRevenue, completed: false }
}
