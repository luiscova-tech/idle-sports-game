// ============================================================
// src/sports/soccer/soccerModule.ts
// Soccer-specific implementation of SportModule<SoccerMatchState>. This is
// the only file allowed to say "goal", "chance", "possession", or "shot".
// ============================================================

import type { SportModule, TickResult, MatchOutcome, MatchContext } from '../../engine/types'

/** Soccer's opaque per-match state, as seen by the engine.
 *
 *  `opponentLevel`/`resolvedOutcome`/`resolvedMargin` are set ONCE, on this
 *  match's very first tick (see `tick()` below), and then carried through
 *  unchanged for the rest of the match — deciding a match's outcome (and
 *  its economic margin) via one early set of rolls and then re-reading them
 *  (rather than re-deriving anything from the live score on every call) is
 *  what keeps getOutcome()/getPerformanceFactor() pure, idempotent
 *  functions of state: the live "if the match ended now" UI preview calls
 *  them repeatedly as a match progresses, and must never re-roll a
 *  different answer on every render. All three are `undefined` before the
 *  first tick, and stay `undefined` for the match's whole duration if no
 *  `context.opponentLevelRange` was ever supplied (the "no such concept"
 *  fallback — see MatchContext in engine/types.ts).
 *
 *  `resolvedMargin` exists SEPARATELY from the live `homeScore`/`awayScore`
 *  specifically so the economic margin bonus (see getPerformanceFactor)
 *  can stay decoupled from the cosmetic score-bias mechanism in tick()
 *  below — see that mechanism's own doc comment for why sharing one number
 *  for both purposes turned into a real, shipped bug. */
export interface SoccerMatchState {
  homeScore: number
  awayScore: number
  elapsedTicks: number
  opponentLevel?: number
  resolvedOutcome?: MatchOutcome
  resolvedMargin?: number
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

/**
 * Continuous, opponent-level-based win probability — supersedes the earlier
 * hard "minimum training level to win" cliff entirely (see CLAUDE.md). Both
 * constants are used LITERALLY (not as an emergent approximation from
 * modulated per-tick rates — an earlier draft tried that and found it
 * fragile: compounding a per-tick bias over 90 independent ticks amplifies
 * it far past the intended per-match sensitivity, and hitting a precise
 * target curve that way required constant-hunting with no clean closed
 * form). Instead, the outcome is resolved by ONE direct roll against this
 * exact formula, once per match (see `tick()` below) — S=4 exactly
 * reproduces the validated anchor point (a 3-level gap -> ~15.1% win
 * chance) by construction, not by simulation-fitting.
 */
const GAP_PROBABILITY_SCALE = 4

/**
 * How much of the non-win probability mass becomes a draw (the rest is a
 * loss), as a fraction of `closeness * (1 - pWin)`, where `closeness =
 * 4 * pWin * (1 - pWin)` peaks at 1 when the match is dead-even (pWin=0.5)
 * and tapers to 0 at extreme mismatches — real sports draws are commonest
 * in close matchups and rare in blowouts, in either direction. This is
 * "your call" territory (the brief only pins down P(win) itself): 0.5 gives
 * a 25%/25% draw/loss split at a perfectly even matchup (close to the old
 * flat model's ~20% draw rate) tapering smoothly to near-0% draws at large
 * mismatches, matched against pWin/pLoss via simulation (see CLAUDE.md).
 * Chosen so pDraw can mathematically never exceed `1 - pWin`, at any pWin —
 * no clamping needed, safe by construction. */
const DRAW_WEIGHT = 0.5

/** Draws this match's opponent level from `range` and resolves the outcome
 *  via the gap-driven probability model above, in one shot. Called exactly
 *  once per match (at its first tick — see `tick()`), never re-rolled. */
function resolveMatchOutcome(playerLevel: number, opponentLevel: number): MatchOutcome {
  const gap = opponentLevel - playerLevel
  const pWin = 1 / (1 + 10 ** (gap / GAP_PROBABILITY_SCALE))
  const closeness = 4 * pWin * (1 - pWin)
  const pDraw = DRAW_WEIGHT * closeness * (1 - pWin)
  const roll = Math.random()
  if (roll < pWin) return 'win'
  if (roll < pWin + pDraw) return 'draw'
  return 'loss'
}

/** How many attempts drawResolvedMargin below makes before giving up and
 *  falling back to the smallest margin consistent with the category. Real
 *  per-match win/draw/loss rates hover around 53%/20%/27% (see the
 *  historical differential-distribution simulation in CLAUDE.md), so even
 *  the rarest target (draw, ~20%) resolves in ~5 attempts on average —
 *  this cap only exists to guarantee termination, not because it's
 *  expected to ever actually get hit. */
const MARGIN_DRAW_MAX_ATTEMPTS = 50

/**
 * Draws this match's ECONOMIC margin — completely independent of tick()'s
 * cosmetic score-bias mechanism below, and of whatever the live score
 * happens to show — by resimulating the match's UNBIASED chance-then-
 * conversion process (the exact same shape/rates `tick()` used before this
 * session's score-bias existed) until one happens to land on the same
 * category as `resolvedOutcome`, then returning ITS differential. This is
 * what keeps the historical goal-differential calibration this file has
 * always used for the margin bonus (see MAX_MEANINGFUL_GOAL_DIFFERENTIAL
 * below: P(|diff|>=5) ~= 3.2% blowouts) completely unaffected by however
 * strongly tick() biases the COSMETIC score for a satisfying visual trend —
 * the two are decided by two genuinely separate draws, only constrained to
 * agree in CATEGORY (never in exact value), so tuning one can never again
 * silently distort the other. Called exactly once per match, at the same
 * moment as resolveMatchOutcome above. */
function drawResolvedMargin(resolvedOutcome: MatchOutcome, config: SoccerConfig): number {
  for (let attempt = 0; attempt < MARGIN_DRAW_MAX_ATTEMPTS; attempt++) {
    let home = 0
    let away = 0
    for (let t = 0; t < config.ticksPerMatch; t++) {
      if (Math.random() < config.homeChancePerTick && Math.random() < config.homeConversionRate) home++
      if (Math.random() < config.awayChancePerTick && Math.random() < config.awayConversionRate) away++
    }
    const diff = home - away
    if (resolvedOutcome === 'win' && diff > 0) return diff
    if (resolvedOutcome === 'loss' && diff < 0) return diff
    if (resolvedOutcome === 'draw' && diff === 0) return 0
  }
  return resolvedOutcome === 'win' ? 1 : resolvedOutcome === 'loss' ? -1 : 0
}

/**
 * How strongly this match's ALREADY-DECIDED resolvedOutcome (see
 * resolveMatchOutcome above) biases the cosmetic tick-by-tick "flavor"
 * scoring for the rest of the match, so the visible run of play trends
 * toward that outcome across the WHOLE match rather than being disconnected
 * from it until the final-tick safety-net nudge below. Ramps linearly from
 * 0 (first tick) to this value (final tick) via `progress =
 * tickIndex / (ticksPerMatch - 1)` — deliberately gradual, not a step
 * function, so it reads as "the run of play increasingly favors one side"
 * rather than a sudden shift partway through.
 *
 * Simulated before picking this value: biasing `conversionRate` ALONE
 * (leaving `chancePerTick` unbiased) left 25-70% of matches still needing
 * the final-tick nudge even at strong bias values, because the underlying
 * scoring process is too infrequent (~7 scoring chances per match per side)
 * for a finishing-only bias to reliably overcome variance — a side with a
 * boosted conversion rate still scores nothing if it never gets a chance to
 * convert. Biasing BOTH `chancePerTick` AND `conversionRate` together
 * brought the nudge-needed rate down to ~1-5% for 'win'/'loss' at strength
 * 1.2 (a 'draw's exact-equality target is a harder statistical ask by
 * nature and still needs the nudge ~36% of the time — but only ever by a
 * single goal, a plausible-looking late equalizer, not a jarring rewrite).
 *
 * IMPORTANT — this constant affects ONLY the cosmetic score display, never
 * the economy, and that separation is load-bearing, not incidental. An
 * earlier version of this fix fed the resulting (now heavily blowout-
 * skewed) live score straight into getPerformanceFactor()'s margin bonus,
 * the same way pre-this-session code always had — an adversarial review
 * caught that this silently inflated average win revenue by ~28% (P(a win
 * is a >=5 differential "blowout") rose from the historically-calibrated
 * ~2.7% to ~67%, since a strong-enough bias to reliably fix the SIGN also
 * reliably produces a bigger MAGNITUDE). Fixed by drawing a wholly separate
 * `resolvedMargin` (see drawResolvedMargin above) from the ORIGINAL
 * unbiased process for economic purposes, so SCORE_BIAS_STRENGTH can be
 * tuned purely for how convincing the cosmetic trend looks, with zero
 * economic side effects — see CLAUDE.md for the full incident writeup.
 */
const SCORE_BIAS_STRENGTH = 1.2
const BIASED_RATE_MIN = 0.02
const BIASED_RATE_MAX = 0.95

function clampRate(rate: number): number {
  return Math.min(BIASED_RATE_MAX, Math.max(BIASED_RATE_MIN, rate))
}

/**
 * Which side this tick's flavor scoring should currently favor, given the
 * match's resolved outcome — `true` favors home, `false` favors away,
 * `null` means no bias at all (outcome not yet resolved — the "no such
 * concept" fallback, matching resolvedOutcome itself). For 'win'/'loss'
 * this is a FIXED direction for the whole match — a resolved loss should
 * increasingly favor the opponent throughout, not just near the end. For
 * 'draw' there is no fixed side to favor (the target is convergence, not
 * either team), so it dynamically favors whichever side is CURRENTLY
 * behind (using the score as of the START of this tick, before this tick's
 * own scoring rolls) — a draw trends toward closing whatever gap has
 * opened, rather than toward a fixed team.
 */
function scoreBiasFavorsHome(
  resolvedOutcome: MatchOutcome | undefined,
  homeScoreBeforeThisTick: number,
  awayScoreBeforeThisTick: number,
): boolean | null {
  if (resolvedOutcome === 'win') return true
  if (resolvedOutcome === 'loss') return false
  if (resolvedOutcome === 'draw') {
    if (homeScoreBeforeThisTick > awayScoreBeforeThisTick) return false
    if (homeScoreBeforeThisTick < awayScoreBeforeThisTick) return true
  }
  return null
}

function tick(
  state: SoccerMatchState,
  tickIndex: number,
  config: SoccerConfig,
  context?: MatchContext,
): TickResult<SoccerMatchState> {
  let { homeScore, awayScore, opponentLevel, resolvedOutcome, resolvedMargin } = state
  let scoringEvent = false

  // First tick of a fresh match: draw this match's opponent level, resolve
  // its outcome, and separately draw its ECONOMIC margin, once, up front —
  // see resolveMatchOutcome/drawResolvedMargin above and the
  // SoccerMatchState doc comment for why this must happen exactly once
  // rather than being re-derived on every getOutcome()/getPerformanceFactor()
  // call. A module with no opponentLevelRange in context (or no context at
  // all) leaves all three fields undefined for the whole match — the "no
  // such concept" fallback, matching every other optional-capability rule
  // here.
  //
  // Gated on `tickIndex === 0`, not just `resolvedOutcome === undefined` —
  // deliberately, to protect a save persisted from BEFORE this field
  // existed: a tier that was mid-match (tickIndex > 0) under an older
  // SoccerMatchState shape has no `resolvedOutcome` key at all after
  // JSON-parsing from localStorage, which would otherwise look identical to
  // "this match's first tick" and trigger a fresh, disconnected-from-the-
  // score resolution partway through — then the final-tick nudge below
  // would rewrite whatever lead the player had already built up to match
  // it. Requiring tickIndex===0 means such a match instead simply never
  // resolves for the rest of ITS lifetime (resolvedOutcome/resolvedMargin
  // stay undefined all the way to completion), so getOutcome() falls back
  // to comparing its real final score — exactly the pre-resolution-model
  // behavior — and only the NEXT match (starting fresh at tickIndex 0)
  // uses the new model.
  if (tickIndex === 0 && resolvedOutcome === undefined && context?.opponentLevelRange) {
    const { min, max } = context.opponentLevelRange
    opponentLevel = min + Math.floor(Math.random() * (max - min + 1))
    resolvedOutcome = resolveMatchOutcome(context.level ?? 1, opponentLevel)
    resolvedMargin = drawResolvedMargin(resolvedOutcome, config)
  }

  // Home/away scoring stays the same chance-then-conversion shape as
  // before — this is still purely decorative match "flavor" (the live
  // score ticker, progress bar); it does not decide the payout, which was
  // already fixed above. What's new: the rates themselves are now biased
  // toward the resolved outcome, growing across the match (see
  // SCORE_BIAS_STRENGTH above), so the visible run of play actually trends
  // toward that outcome throughout — not just via the final-tick safety
  // net below. Uses the score as of the START of this tick (before either
  // side's roll this tick) to decide which side a 'draw' currently favors.
  const favorsHome = scoreBiasFavorsHome(resolvedOutcome, homeScore, awayScore)
  let homeChance = config.homeChancePerTick
  let awayChance = config.awayChancePerTick
  let homeConversionRate = config.homeConversionRate
  let awayConversionRate = config.awayConversionRate
  if (favorsHome !== null) {
    const progress = tickIndex / (config.ticksPerMatch - 1)
    const strength = SCORE_BIAS_STRENGTH * progress
    const boost = 1 + strength
    const cut = 1 - strength
    homeChance = clampRate(config.homeChancePerTick * (favorsHome ? boost : cut))
    awayChance = clampRate(config.awayChancePerTick * (favorsHome ? cut : boost))
    homeConversionRate = clampRate(config.homeConversionRate * (favorsHome ? boost : cut))
    awayConversionRate = clampRate(config.awayConversionRate * (favorsHome ? cut : boost))
  }

  if (Math.random() < homeChance) {
    if (Math.random() < homeConversionRate) {
      homeScore += 1
      scoringEvent = true
    }
  }
  if (Math.random() < awayChance) {
    if (Math.random() < awayConversionRate) {
      awayScore += 1
      scoringEvent = true
    }
  }

  // On the final tick, nudge the flavor score (minimally, only if needed)
  // so it agrees with the already-resolved outcome by the time the match
  // completes — the two systems are independent for 89 ticks, but should
  // never disagree at the moment a match actually pays out.
  if (tickIndex === config.ticksPerMatch - 1 && resolvedOutcome !== undefined) {
    if (resolvedOutcome === 'win' && homeScore <= awayScore) {
      homeScore = awayScore + 1
    } else if (resolvedOutcome === 'loss' && awayScore <= homeScore) {
      awayScore = homeScore + 1
    } else if (resolvedOutcome === 'draw' && homeScore !== awayScore) {
      const higher = Math.max(homeScore, awayScore)
      homeScore = higher
      awayScore = higher
    }
  }

  return {
    state: {
      homeScore,
      awayScore,
      elapsedTicks: tickIndex + 1,
      opponentLevel,
      resolvedOutcome,
      resolvedMargin,
    },
    scoringEvent,
  }
}

function rawOutcomeOf(state: SoccerMatchState): MatchOutcome {
  if (state.homeScore > state.awayScore) return 'win'
  if (state.homeScore === state.awayScore) return 'draw'
  return 'loss'
}

/**
 * The single source of truth both getOutcome() and getPerformanceFactor()
 * read from — sharing this is what keeps them structurally unable to drift
 * apart (see the doc comment on SportModule.getPerformanceFactor in
 * engine/types.ts: an earlier version of this file computed a downgrade
 * only inside getOutcome and left getPerformanceFactor reading the raw
 * score unconditionally, letting a margin bonus leak into an outcome it was
 * never meant to apply to). Prefers `state.resolvedOutcome` (the
 * probability-model result, set once at the match's first tick) when
 * present; falls back to comparing the raw score when it's absent (no
 * `context.opponentLevelRange` was ever supplied for this match — the
 * "no such concept" case, or a freshly-created match state before its
 * first tick has run).
 */
function resolvedOutcomeOf(state: SoccerMatchState): MatchOutcome {
  return state.resolvedOutcome ?? rawOutcomeOf(state)
}

/** Exported so UI can derive a live "if the match ended now" projected
 *  outcome from mid-match state, reusing the exact same logic the engine
 *  uses at actual match completion — never duplicated in a component. Once
 *  a match's first tick has run, this is no longer really a "projection" of
 *  a still-changing score (the outcome was already decided up front) — it's
 *  a truthful early reveal of a result that won't change, which the
 *  existing "if the match ended now" phrasing still holds up under: it was
 *  always answering "what does the current state resolve to," and the
 *  answer just happens to now be fixed from the first tick on. */
export function getOutcome(state: SoccerMatchState): MatchOutcome {
  return resolvedOutcomeOf(state)
}

/** The most meaningful goal differential for margin-bonus purposes — beyond
 *  this, an even bigger blowout doesn't add further bonus. Simulated against
 *  400k matches of the real (unbiased) tick probabilities above: P(|
 *  differential| >= 5) ~= 3.2%, and specifically P(a win by >= 5) ~= 2.7% —
 *  a real but genuinely rare "blowout" tail, not something an average match
 *  brushes up against (the median-ish differential band is 0-2). This stays
 *  true of `resolvedMargin` (see drawResolvedMargin above) regardless of
 *  how the cosmetic score in tick() is biased, specifically BECAUSE
 *  `resolvedMargin` is drawn from that same original unbiased process. */
const MAX_MEANINGFUL_GOAL_DIFFERENTIAL = 5

/**
 * Exported for the same drift-proof-preview reason as getOutcome above:
 * economy.ts's margin bonus (see calculateMatchRevenue) only ever consumes
 * this generic 0-1 number — 0 = most lopsided possible loss, 0.5 = neutral
 * (any draw sits exactly here), 1 = most decisive possible win. Linear in
 * the clamped differential between the two extremes.
 *
 * Reads `state.resolvedMargin` — the economic margin drawn once at
 * resolution (see drawResolvedMargin above), deliberately SEPARATE from the
 * live, cosmetically-biased `homeScore`/`awayScore` — rather than the live
 * score itself. Falls back to the raw live differential only when
 * `resolvedMargin` was never drawn (no `context.opponentLevelRange` ever
 * supplied — the same "no such concept" case `resolvedOutcomeOf` falls back
 * for, where the live score IS the authoritative truth, exactly as it was
 * before any of this session's or last session's resolution model existed).
 */
export function getPerformanceFactor(state: SoccerMatchState): number {
  const diff = state.resolvedMargin ?? state.homeScore - state.awayScore
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
    tick: (state, tickIndex, context) => tick(state, tickIndex, config, context),
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

/** The next not-yet-reached milestone level above `level`, or `null` once
 *  every milestone in TRAINING_MILESTONE_LEVELS has been passed. Exported
 *  so the UI can show a compact "next: 2x at Level N" indicator without
 *  duplicating TRAINING_MILESTONE_LEVELS' shape — every milestone crossing
 *  doubles the CURRENT cumulative effect, so "2x" is always the correct
 *  framing for the next one, regardless of how many have already passed. */
export function nextMilestoneLevel(level: number): number | null {
  return TRAINING_MILESTONE_LEVELS.find((milestone) => level < milestone) ?? null
}

/** The largest already-crossed milestone at or below `level`, or `1` (the
 *  starting level every tier's training begins at) if none have been
 *  crossed yet. Paired with nextMilestoneLevel() so the UI can show
 *  progress SINCE the previous milestone rather than the raw level over the
 *  next one — the latter looks right only for the very first milestone (no
 *  earlier one to net out against) and is misleadingly pre-filled for every
 *  milestone after that (e.g. right after crossing to level 13, naively
 *  showing `13/22` reads as 59% progress toward the NEXT doubling, despite
 *  zero levels having been trained since the crossing that just happened). */
export function previousMilestoneLevel(level: number): number {
  let previous = 1
  for (const milestone of TRAINING_MILESTONE_LEVELS) {
    if (level >= milestone) previous = milestone
  }
  return previous
}

/**
 * The [min, max] level range this tier's per-match opponent is drawn from
 * (see MatchContext.opponentLevelRange in engine/types.ts and
 * resolveMatchOutcome above) — supersedes the earlier flat `minWinLevel`
 * hard cliff entirely (see CLAUDE.md). Centered on the exact same
 * `tierIndex + 1` anchor the old cliff used (1 for tier 0, up to 11 for The
 * Multiverse Cup) — that number was already simulated last session against
 * this game's real cost/revenue curves to land within single-digit-minutes
 * of dedicated play at low tiers and a genuine-but-never-impossible few-
 * hours-to-low-days investment at the top tier, and centering the new range
 * on it preserves that calibration rather than re-deriving it from scratch.
 * What changes is the shape: instead of "below this level, a win is
 * impossible," a fixed ±2 spread around that center means EVERY match
 * draws a slightly different opponent, and — combined with the continuous
 * probability curve — even a tier a player has just reached (level 1) has a
 * real, nonzero (if small) chance to win immediately, with the odds
 * smoothly improving as training catches up to the range's center, rather
 * than flipping from "impossible" to "normal" at one specific level. */
export function opponentLevelRangeForTier(tierIndex: number): { min: number; max: number } {
  const center = tierIndex + 1
  return { min: Math.max(1, center - 2), max: center + 2 }
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
