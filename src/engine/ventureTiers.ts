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
import { expectedMatchRevenue } from './economy'

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
  /**
   * Epoch ms of the last MANUAL interaction with this tier specifically — a
   * click on its action button, or a purchase made on it (unlock / hire a
   * manager / improve training). Drives the unattended-auto-play pause
   * below. Deliberately NOT touched by an automatic tick: the whole point is
   * to measure how long the tier has been running without the player.
   *
   * `0` means "never manually interacted with", which `isAutoPlayPaused`
   * treats as NOT paused rather than as infinitely stale — see that
   * function's own doc comment for why that direction is the safe one.
   */
  lastInteractionMs: number
}

/**
 * How long a manager-hired tier may auto-play WITHOUT any manual interaction
 * before its auto-ticking pauses.
 *
 * 4 hours, and simulation says that is comfortable rather than arbitrary:
 * the threshold has to clear ONE full match at the SLOWEST tier by a wide
 * margin, or a player checking in on schedule would routinely find a frozen
 * half-match. Measured against the real `autoTickIntervalMsForTier` and each
 * sport's real match length, the slowest match anywhere is soccer's tier 10
 * at ~26.0 minutes, so 4h is ~9.2 of those (and ~267 matches at soccer tier
 * 0, ~923 at baseball tier 0). For contrast a 1h threshold would be only
 * ~2.3 of that slowest match — tight enough that a single interrupted
 * check-in could strand a match mid-flight. 8h clears it too but weakens
 * what the mechanic is for. 4h keeps the intended meaning ("this has been
 * running unattended for a long time") while never being able to interrupt
 * a match a player is plausibly watching.
 */
export const UNATTENDED_AUTO_PLAY_PAUSE_MS = 4 * 60 * 60 * 1000

/**
 * Whether this tier's AUTO-ticking is currently paused for inactivity.
 *
 * Time is an explicit `nowMs` PARAMETER, never read from the system clock
 * inside — this project's established precedent for testable time-based code
 * (see the Daily/Weekly objectives amendment in CLAUDE.md). It is what lets
 * the exact 4-hour boundary be asserted directly rather than waited out.
 *
 * Returns the complete answer to "is auto-play blocked right now", so the
 * store's tick guard and the card's paused message are literally the same
 * check: a tier that is locked, or has no manager, has no auto-play to pause
 * and so is never reported as paused.
 *
 * FAIL-OPEN on a missing/invalid stamp (`0`, negative, or non-finite):
 * reported as NOT paused. That direction is deliberate. A brand-new tier is
 * created with `0` and legitimately has no interaction history yet — but it
 * also has no manager, and the only way to hire one is a manual purchase,
 * which stamps a real timestamp, so a genuinely auto-playing tier always has
 * one. The remaining ways to see `0`/garbage here are a hand-edited or
 * partially-corrupted save, where failing CLOSED would silently freeze a
 * player's whole economy with no obvious cause; failing open merely restores
 * the pre-existing always-on behaviour until their next interaction stamps
 * it properly. Never pause because of bad data.
 *
 * DELIBERATELY NOT consulted by `tierIncomeRatePerSecond` below, which keeps
 * counting a paused tier's income. Adversarial review raised this three
 * times independently and reproduced the magnitude (a save with every tier
 * paused still reports its full structural rate), so the reasoning is
 * recorded here rather than left implicit. It is KEPT, for three reasons:
 *
 *  1. THE OPPOSITE DIRECTION IS AN ACTUAL EXPLOIT. That rate sizes
 *     income-scaled objective TARGETS (`resolveObjectiveTarget`). If paused
 *     tiers were excluded, a player whose tiers all pause overnight — which
 *     happens on its own, for free — would have the rate collapse to
 *     OBJECTIVE_FLOOR_INCOME_RATE, so the daily rolling over at local
 *     midnight would draw a trivially cheap "Earn N Revenue" target that
 *     they then complete instantly on resuming. Letting the game go idle
 *     must never be the optimal way to play it.
 *  2. FOR REWARDS IT IS GENEROUS, NEVER EXPLOITABLE. Pricing a reward off
 *     structural income can only over-pay relative to what a paused player
 *     is actually earning, and buying that over-payment costs them all their
 *     real income in the meantime — nobody comes out ahead.
 *  3. THE DOWNSIDE IS SELF-CORRECTING BY DESIGN. The honest cost is that a
 *     target drawn while tiers are paused is sized against income the player
 *     is not currently earning, so it reads as too hard until they resume —
 *     and resuming is one click per tier, which is exactly the behaviour
 *     this whole mechanic exists to elicit.
 *
 * The tripwire for a future session: if a reward or target is ever derived
 * from this rate in a context where OVER-stating it would benefit the player
 * for doing nothing, that consumer needs its own paused-aware rate — not a
 * change here, which would reopen (1).
 */
export function isAutoPlayPaused(
  tier: { unlocked: boolean; managerHired: boolean; lastInteractionMs: number },
  nowMs: number,
  thresholdMs: number = UNATTENDED_AUTO_PLAY_PAUSE_MS,
): boolean {
  if (!tier?.unlocked || !tier.managerHired) return false
  const stamp = tier.lastInteractionMs
  if (!Number.isFinite(stamp) || stamp <= 0) return false
  if (!Number.isFinite(nowMs)) return false
  // `>=` so the boundary itself pauses — the threshold is "this many hours
  // of inactivity is too long", and the harness pins the exact instant.
  return nowMs - stamp >= thresholdMs
}

/** Revenue cost to raise a tier currently at `currentLevel` to the next level. */
export function tierUpgradeCost(config: VentureTierConfig, currentLevel: number): number {
  return Math.round(config.upgradeBaseCost * config.upgradeCostGrowth ** (currentLevel - 1))
}

/**
 * Rescales a WHOLE reference tier ladder by a single multiplicative factor —
 * the sport-agnostic mechanism behind this project's "income-rate-anchored
 * entry costs" standing convention (see CLAUDE.md). Multiplies ONLY the
 * three COST-side fields (`unlockCost`, `managerHireCost`, `upgradeBaseCost`)
 * by `anchorMultiplier`, rounded; `id`/`name`/`icon`/`upgradeCostGrowth`
 * pass through unchanged.
 *
 * `baseRevenueMultiplier` is DELIBERATELY, EXPLICITLY excluded from scaling —
 * see the "cost-anchoring must never touch revenue fields" note in
 * CLAUDE.md. This function previously scaled it alongside the cost fields
 * (a real, shipped bug — see CLAUDE.md's dedicated writeup), which let a
 * wealthy player's re-anchored baseball tier generate revenue proportional
 * to their EXISTING wealth rather than their actual level/training/manager
 * investment in that tier — a fresh Level-1 tier could out-earn a
 * heavily-trained one by orders of magnitude, completely defeating the
 * anchor's purpose (higher entry cost was supposed to mean a REAL grind, not
 * a bigger-looking but equally-trivial one). Revenue must be driven purely
 * by the SAME mechanics as soccer: `level`/`trainingEffectMultiplier`/
 * `managerHired` automation status — zero influence from how wealthy the
 * player happens to be.
 *
 * `upgradeCostGrowth` also does NOT get rescaled — it's a dimensionless
 * per-level growth RATE, not an absolute currency amount, so leaving it
 * alone is what makes the ladder's cost SHAPE (tier-to-tier cost ratios)
 * come out byte-for-byte identical to the reference curve, just relocated to
 * a new absolute starting point. This is why a single scalar is sufficient
 * to "re-anchor" an entire ladder's COSTS at once, rather than needing to
 * separately re-derive each tier's own ratio.
 */
export function scaledTierConfigs(
  referenceTiers: VentureTierConfig[],
  anchorMultiplier: number,
): VentureTierConfig[] {
  return referenceTiers.map((config) => ({
    ...config,
    unlockCost: Math.round(config.unlockCost * anchorMultiplier),
    managerHireCost: Math.round(config.managerHireCost * anchorMultiplier),
    upgradeBaseCost: Math.round(config.upgradeBaseCost * anchorMultiplier),
    // baseRevenueMultiplier is INTENTIONALLY absent here — see this
    // function's own doc comment above. Do not add it back.
  }))
}

/**
 * Derives the multiplier `scaledTierConfigs` above should apply, from a
 * snapshot of the player's current aggregate income rate (Revenue/second,
 * summed across every unlocked+managed tier of every sport — see
 * useGameStore.ts's `currentAggregateIncomeRatePerSecond`) — see CLAUDE.md's
 * "income-rate-anchored entry costs" convention for the full reasoning.
 *
 * `anchorSeconds` is how many seconds of that income rate the REFERENCE
 * ladder's OWN first tier's `unlockCost` should represent once rescaled —
 * e.g. at `anchorSeconds=60`, a player earning 10,000 Revenue/second sees
 * that first tier cost roughly 600,000 (60 seconds of their OWN current
 * earning power), regardless of how large or small the reference curve's
 * own hardcoded number originally was.
 *
 * The result never drops below `1` — the reference curve's OWN numbers,
 * completely unscaled — which is what protects a near-zero-income player (a
 * genuinely fresh save, or one that simply hasn't invested in anything yet)
 * from the opposite failure mode this convention exists to avoid: a sport
 * becoming suspiciously CHEAPER than its own original, carefully-simulated
 * baseline just because "current income" briefly reads as near-zero.
 * Defensively collapses any non-finite or non-positive income rate (a
 * corrupted save, a divide-by-zero-shaped edge case) to that same floor,
 * rather than ever propagating a NaN/Infinity into a persisted cost ladder —
 * once a migration BAKES this multiplier into a save, there is no periodic
 * recomputation to later self-correct a poisoned value.
 */
export function incomeRateAnchorMultiplier(
  incomeRatePerSecond: number,
  anchorSeconds: number,
  referenceFirstTierUnlockCost: number,
): number {
  if (!Number.isFinite(incomeRatePerSecond) || incomeRatePerSecond <= 0) return 1
  // Re-check the RESULT for finiteness, not just the input — a finite but
  // astronomically large income (a corrupted/hand-edited save) times
  // anchorSeconds can overflow to Infinity, and `Math.max(1, Infinity)` is
  // Infinity, which would then bake a non-finite multiplier into the save
  // (poisoning scaledTierConfigs into Infinity/NaN costs). This function's
  // own doc promises to never propagate a non-finite value, so it must guard
  // its output, not merely its input — not reachable with any realistic
  // income, but an adversarial review flagged the gap between the stated
  // guarantee and the code.
  const raw = (incomeRatePerSecond * anchorSeconds) / referenceFirstTierUnlockCost
  return Number.isFinite(raw) ? Math.max(1, raw) : 1
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

/**
 * This ONE tier's expected Revenue-per-real-world-second, at its CURRENT
 * level/manager status, blending both income sources every tier has (direct
 * per-tick Revenue, and the expected match-completion bonus averaged over
 * the tier's own real auto-tick pace) into one steady-state rate. Feeds the
 * income-rate-scaled achievement rewards (see CLAUDE.md's income-rate-
 * scaled-rewards amendment) — reuses `expectedMatchRevenue` (economy.ts)
 * directly rather than a second, separately-maintained payout estimate,
 * matching this project's own repeated "don't duplicate the payout math"
 * lesson.
 *
 * Returns exactly 0 for a locked OR manager-less tier — a tier only being
 * played via manual clicks has no PASSIVE rate to speak of (this is a
 * "current income RATE," not "how much Revenue could this tier ever
 * produce"), and this is deliberate: a player who has never hired any
 * manager gets a rate of 0 from every tier, which is exactly why the
 * income-rate-scaled reward needs its own floor (see AchievementReward's
 * `scaledRevenue` variant) rather than assuming a nonzero rate always exists.
 *
 * `computeOutcomeProbabilities` is a parameter (not a hardcoded import),
 * mirroring VentureCard.tsx's own prop of the same name — this file must
 * stay agnostic to which sport's WITH-draw or WITHOUT-draw distribution
 * applies, exactly like that existing prop's own doc comment explains.
 * `estimatedTicksPerMatch` is likewise a parameter (soccer's fixed
 * `ticksPerMatch`, or baseball's own per-tier `estimatedTicksForBaseballTier`)
 * — this file has no way to know a variable-length sport's real average
 * match length itself, so the caller (whoever already tracks that) supplies
 * it, matching VentureCard.tsx's own `estimatedTicksPerMatch` prop.
 *
 * Uses each tier's STRUCTURAL expected opponent (the mean of
 * opponentLevelRangeForTier's own range), not any specific match's already-
 * drawn opponentLevel — deliberately, so this "current economy" reading
 * doesn't fluctuate based on which random opponent an unrelated in-flight
 * match on this tier happens to be facing at the exact instant a reward is
 * granted elsewhere. A tier's rate is a function of (tierIndex, level)
 * alone, not of any one match's own randomness.
 */
export function tierIncomeRatePerSecond(
  tier: { unlocked: boolean; managerHired: boolean; level: number },
  tierIndex: number,
  config: VentureTierConfig,
  legacyMultiplier: number,
  computeOutcomeProbabilities: (playerLevel: number, opponentLevel: number) => Record<MatchOutcome, number>,
  estimatedTicksPerMatch: number,
): number {
  if (!tier.unlocked || !tier.managerHired) return 0

  const ticksPerSecond = 1000 / autoTickIntervalMsForTier(tierIndex)
  const perTickRevenuePerSecond = tierPerTickRevenue(config, tier.level) * legacyMultiplier * ticksPerSecond

  const { min, max } = opponentLevelRangeForTier(tierIndex)
  const expectedOpponentLevel = (min + max) / 2
  const probabilities = computeOutcomeProbabilities(tier.level, expectedOpponentLevel)
  const expectedCompletionRevenue =
    expectedMatchRevenue(probabilities) *
    config.baseRevenueMultiplier *
    trainingEffectMultiplier(tier.level) *
    legacyMultiplier
  const completionRevenuePerSecond = (expectedCompletionRevenue * ticksPerSecond) / estimatedTicksPerMatch

  return perTickRevenuePerSecond + completionRevenuePerSecond
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
