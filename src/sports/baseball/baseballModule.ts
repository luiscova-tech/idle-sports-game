// ============================================================
// src/sports/baseball/baseballModule.ts
// Baseball-specific implementation of SportModule<BaseballMatchState>. This
// is the only file allowed to say "inning", "out", "at-bat", "run", or any
// other baseball-specific noun. See CLAUDE.md's "Baseball" amendment for
// the full design writeup (tick-granularity decision, no-draw resolution
// decision, and how this reuses soccer's shared engine pieces rather than
// duplicating them).
//
// TICK GRANULARITY: one tick = one at-bat (plate appearance), NOT one
// inning. A half-inning ends after exactly 3 outs, which a sequence of
// random at-bat rolls takes a genuinely VARIABLE number of ticks to reach —
// this is why SportModule.isMatchComplete exists (see engine/types.ts):
// baseball can't tell the engine "this match is done" by comparing a raw
// tick count against a fixed ticksPerMatch the way soccer does, since the
// actual number of at-bats needed to complete N innings isn't knowable in
// advance. `ticksPerMatch` below is kept as a rough ESTIMATE (used only to
// size the progress bar) — `isMatchComplete` is what's actually
// authoritative for ending a match.
// ============================================================

import type { SportModule, TickResult, MatchOutcome, MatchContext } from '../../engine/types'
import { resolveMatchOutcomeWithoutDraw } from '../../engine/winProbability'
import type { VentureTierConfig } from '../../engine/ventureTiers'

/**
 * Baseball's opaque per-match state. Mirrors soccer's SoccerMatchState
 * shape/philosophy closely (see that file's own doc comment): `opponentLevel`
 * /`resolvedOutcome`/`resolvedMargin`/`totalInnings` are all set ONCE, on
 * this match's first tick, then read back out unchanged for the rest of the
 * match, keeping getOutcome()/getPerformanceFactor() pure and idempotent.
 *
 * `resolvedOutcome` is typed as the shared `MatchOutcome` for interface
 * consistency with every other sport module, but baseball's own resolution
 * path (see resolveMatchOutcomeWithoutDraw in winProbability.ts) is
 * guaranteed to never actually produce 'draw' — see this file's "no draw
 * state" design note below tick().
 *
 * `gameOver` is the single authoritative "is this match actually over"
 * flag (see isMatchComplete below) — set exactly once, at the tick that
 * decides the game (3 outs completing a decided final/extra half-inning, or
 * a walk-off), never recomputed from inning/outs/score after the fact.
 */
export interface BaseballMatchState {
  inning: number
  half: 'top' | 'bottom'
  outs: number
  /** Player's team — bats in the BOTTOM half, matching real baseball's
   *  home-team-bats-second convention (and its "home team doesn't need to
   *  bat if already ahead" walk-off rule, implemented below). */
  homeScore: number
  /** Opponent — bats in the TOP half. */
  awayScore: number
  elapsedTicks: number
  opponentLevel?: number
  resolvedOutcome?: MatchOutcome
  resolvedMargin?: number
  /** Captured once from context.matchLength at tick 0 — see MatchContext in
   *  engine/types.ts. Read back out by isMatchComplete/tick() for the rest
   *  of the match rather than re-reading context every tick, matching the
   *  "resolve once into opaque state" pattern this file uses throughout. */
  totalInnings?: number
  gameOver?: boolean
}

/** Tunable baseball-specific rates, shared across every baseball tier
 *  (mirroring soccer's DEFAULT_SOCCER_CONFIG — per-tier differentiation
 *  comes from baseRevenueMultiplier/opponent-level-range/inning count, not
 *  from different at-bat rates per tier). A small home-field edge (lower
 *  homeOutProbability, higher homeScoreGivenNotOutProbability) mirrors
 *  soccer's own slight home advantage (0.32 vs 0.26 conversion) for
 *  thematic consistency across sports.
 *
 *  DELIBERATE SIMPLIFICATION, documented rather than silently glossed over:
 *  this models each at-bat as a flat three-way roll (out / scores a run /
 *  reaches base without scoring) with NO individual baserunner/bases-state
 *  tracking. Real baseball's run-scoring depends heavily on who's already
 *  on base; a full baserunner simulation was judged not worth the added
 *  complexity for this validation slice (this is intentionally a small
 *  slice validating the engine abstraction, not a full baseball sim) — the
 *  simplification is visible only in HOW a run gets scored, never in
 *  whether the shared win-probability/economy math gets duplicated, which
 *  is the actual concern this session's audit was about. */
export interface BaseballConfig {
  homeOutProbability: number
  awayOutProbability: number
  homeScoreGivenNotOutProbability: number
  awayScoreGivenNotOutProbability: number
}

export const DEFAULT_BASEBALL_CONFIG: BaseballConfig = {
  homeOutProbability: 0.68,
  awayOutProbability: 0.7,
  homeScoreGivenNotOutProbability: 0.36,
  awayScoreGivenNotOutProbability: 0.34,
}

function createInitialState(): BaseballMatchState {
  return { inning: 1, half: 'top', outs: 0, homeScore: 0, awayScore: 0, elapsedTicks: 0 }
}

/** How many attempts drawResolvedMargin below makes before giving up and
 *  falling back to the smallest margin consistent with the category — same
 *  termination-guarantee role as soccer's MARGIN_DRAW_MAX_ATTEMPTS. Each
 *  "attempt" here is a full independent simulated game (including its own
 *  extra-innings-until-decided resolution — see below), not a single
 *  at-bat, so this cap is intentionally much smaller than the number of
 *  at-bats in a game. */
const MARGIN_DRAW_MAX_ATTEMPTS = 30
/** Safety cap on extra innings simulated within ONE margin-draw attempt, to
 *  guarantee termination even in a pathological all-ties run — real games
 *  essentially never need more than a couple of extra innings to decide. */
const MARGIN_DRAW_MAX_EXTRA_INNINGS = 20

/**
 * Draws this match's ECONOMIC run-differential margin — completely
 * independent of tick()'s cosmetic score-bias mechanism below, by
 * resimulating a full UNBIASED baseball game (the same at-bat rates
 * tick() uses before any bias is applied) — including a genuine
 * extra-innings-until-decided resolution, since an isolated resimulation
 * like this can afford to actually loop rather than needing the LIVE
 * game's final-inning "nudge" shortcut (see tick() below for why the live
 * game uses a cheaper approach instead) — until one full simulated game's
 * winner matches `resolvedOutcome`, then returns ITS run differential. This
 * is the exact same decoupling technique soccer's drawResolvedMargin uses,
 * for the exact same reason: keeping the economic margin bonus (see
 * getPerformanceFactor below) statistically independent of however
 * strongly the COSMETIC live game is biased for a satisfying visual trend.
 */
function drawResolvedMargin(resolvedOutcome: MatchOutcome, config: BaseballConfig, totalInnings: number): number {
  for (let attempt = 0; attempt < MARGIN_DRAW_MAX_ATTEMPTS; attempt++) {
    let home = 0
    let away = 0
    let inning = 1
    let extraInnings = 0
    while (true) {
      // Top half: away bats.
      for (let outs = 0; outs < 3; ) {
        if (Math.random() < config.awayOutProbability) {
          outs++
        } else if (Math.random() < config.awayScoreGivenNotOutProbability) {
          away++
        }
      }
      // Walk-off: home already ahead at/past the scheduled length skips batting.
      if (inning >= totalInnings && home > away) break
      // Bottom half: home bats.
      for (let outs = 0; outs < 3; ) {
        if (home > away && inning >= totalInnings) break // mid-inning walk-off
        if (Math.random() < config.homeOutProbability) {
          outs++
        } else if (Math.random() < config.homeScoreGivenNotOutProbability) {
          home++
        }
      }
      if (inning >= totalInnings) {
        if (home !== away) break
        extraInnings++
        if (extraInnings > MARGIN_DRAW_MAX_EXTRA_INNINGS) break
      }
      inning++
    }
    const diff = home - away
    if (resolvedOutcome === 'win' && diff > 0) return diff
    if (resolvedOutcome === 'loss' && diff < 0) return diff
    if (resolvedOutcome === 'draw' && diff === 0) return 0
  }
  return resolvedOutcome === 'win' ? 1 : resolvedOutcome === 'loss' ? -1 : 0
}

const SCORE_BIAS_STRENGTH = 1.2
const BIASED_PROBABILITY_MIN = 0.02
const BIASED_PROBABILITY_MAX = 0.95

function clampProbability(p: number): number {
  return Math.min(BIASED_PROBABILITY_MAX, Math.max(BIASED_PROBABILITY_MIN, p))
}

/** Which side tick()'s flavor at-bats should currently favor — mirrors
 *  soccer's scoreBiasFavorsHome, but simpler: baseball has NO draw state
 *  (see the design note below tick()), so resolvedOutcome is always
 *  'win'/'loss'/undefined, never 'draw' — meaning the favored side is FIXED
 *  for the whole game, with no "which side is currently behind" dynamic
 *  case needed at all. */
function scoreBiasFavorsHome(resolvedOutcome: MatchOutcome | undefined): boolean | null {
  if (resolvedOutcome === 'win') return true
  if (resolvedOutcome === 'loss') return false
  return null
}

function tick(
  state: BaseballMatchState,
  tickIndex: number,
  config: BaseballConfig,
  context?: MatchContext,
): TickResult<BaseballMatchState> {
  let { inning, half, outs, homeScore, awayScore, opponentLevel, resolvedOutcome, resolvedMargin, totalInnings, gameOver } =
    state
  let scoringEvent = false

  // First tick of a fresh match: draw the opponent level, resolve the TRUE
  // outcome, draw the decoupled economic margin, and capture this tier's
  // configured inning count — all once, up front. Gated on tickIndex===0,
  // not just resolvedOutcome===undefined, for the exact save-migration
  // safety reason documented in soccerModule.ts's tick().
  //
  // NO DRAW STATE, BY DESIGN: real baseball has no ties — a game tied after
  // its scheduled innings plays extra innings until decided. This project's
  // shared economy/achievements/milestone systems assume a generic
  // win/draw/loss MatchOutcome triad, but nothing about them REQUIRES every
  // sport to actually produce all three — achievements' totalWins line only
  // ever checks for 'win', and economy.ts's calculateMatchRevenue handles
  // any MatchOutcome generically. So baseball resolves via
  // resolveMatchOutcomeWithoutDraw (winProbability.ts) — the SAME win/loss
  // RATIO the shared formula produces, with its draw probability mass
  // proportionally redistributed into win/loss — rather than inventing a
  // second probability model, and rather than accepting an "abstracted
  // draw" purely for triad-consistency with soccer. This was a genuine
  // design choice, not a default: an abstracted draw would have been less
  // work (zero special-casing), but would have made baseball's very first
  // implemented mechanic behave unrealistically for the one sport-specific
  // rule the user explicitly called out as real ("real baseball has no
  // ties") — worth the small amount of extra resolution logic below (the
  // walk-off/extra-innings-nudge handling) to get right.
  // totalInnings is assigned SEPARATELY from (and unconditionally on) the
  // resolvedOutcome/opponentLevel/resolvedMargin resolution below —
  // deliberately, per an adversarial-review finding this session: an
  // earlier version only ever set totalInnings INSIDE the
  // context?.opponentLevelRange-gated block, so a match ticked with
  // matchLength supplied but opponentLevelRange NOT supplied (or with no
  // context at all) left totalInnings permanently undefined, which then
  // permanently skipped the ENTIRE match-progression block below
  // (`!gameOver && totalInnings !== undefined`) — the game could never
  // reach 3 outs, never set gameOver, and isMatchComplete() would return
  // false forever. That silently violated MatchContext's own documented
  // contract that each field is independently, safely ignorable ("a sport
  // module with no such concept ignores it entirely") — omitting one
  // optional field must degrade gracefully, never freeze the sim. Setting
  // totalInnings unconditionally here means the innings/outs/score
  // progression always runs regardless of what context supplies; only the
  // TRUE-outcome resolution (which genuinely has nothing sensible to do
  // without an opponent level to compare against) stays gated. Without a
  // resolvedOutcome, scoreBiasFavorsHome already returns null (no bias) and
  // getOutcome()'s fallback compares the raw, now-genuinely-undetermined
  // score — the same "no such concept" fallback pattern soccer's own
  // resolvedOutcomeOf already uses, including the possibility of a genuine
  // 'draw' in that fallback-only case (never reachable through the real
  // tickBaseballTier path, which always supplies both fields).
  if (tickIndex === 0 && totalInnings === undefined) {
    totalInnings = context?.matchLength ?? 9
  }

  // NO DRAW STATE, BY DESIGN: real baseball has no ties — a game tied after
  // its scheduled innings plays extra innings until decided. This project's
  // shared economy/achievements/milestone systems assume a generic
  // win/draw/loss MatchOutcome triad, but nothing about them REQUIRES every
  // sport to actually produce all three — achievements' totalWins line only
  // ever checks for 'win', and economy.ts's calculateMatchRevenue handles
  // any MatchOutcome generically. So baseball resolves via
  // resolveMatchOutcomeWithoutDraw (winProbability.ts) — the SAME win/loss
  // RATIO the shared formula produces, with its draw probability mass
  // proportionally redistributed into win/loss — rather than inventing a
  // second probability model, and rather than accepting an "abstracted
  // draw" purely for triad-consistency with soccer. This was a genuine
  // design choice, not a default: an abstracted draw would have been less
  // work (zero special-casing), but would have made baseball's very first
  // implemented mechanic behave unrealistically for the one sport-specific
  // rule the user explicitly called out as real ("real baseball has no
  // ties") — worth the small amount of extra resolution logic below (the
  // walk-off/extra-innings-nudge handling) to get right.
  if (tickIndex === 0 && resolvedOutcome === undefined && context?.opponentLevelRange) {
    const { min, max } = context.opponentLevelRange
    opponentLevel = min + Math.floor(Math.random() * (max - min + 1))
    resolvedOutcome = resolveMatchOutcomeWithoutDraw(context.level ?? 1, opponentLevel)
    // totalInnings is always already a number here (the block above always
    // assigns it when tickIndex===0) — the `?? 9` fallback is only to
    // satisfy TypeScript's control-flow analysis across the two separate
    // if-blocks, not a real runtime fallback path.
    resolvedMargin = drawResolvedMargin(resolvedOutcome, config, totalInnings ?? 9)
  }

  if (!gameOver && totalInnings !== undefined) {
    const favorsHome = scoreBiasFavorsHome(resolvedOutcome)
    const battingHome = half === 'bottom'
    const favored = favorsHome !== null && favorsHome === battingHome

    let outProbability = battingHome ? config.homeOutProbability : config.awayOutProbability
    let scoreGivenNotOutProbability = battingHome
      ? config.homeScoreGivenNotOutProbability
      : config.awayScoreGivenNotOutProbability

    if (favorsHome !== null) {
      // Progress through the scheduled innings, not raw tick count (a
      // baseball match's real length in ticks is unknown in advance) —
      // 0 at the very first at-bat, approaching 1 by the last scheduled
      // half-inning. Same gradual-ramp shape as soccer's
      // tickIndex/(ticksPerMatch-1), analogous but innings-based.
      const progress = Math.min(
        1,
        (inning - 1 + (half === 'bottom' ? 0.5 : 0)) / totalInnings,
      )
      const strength = SCORE_BIAS_STRENGTH * progress
      outProbability = clampProbability(outProbability * (favored ? 1 - strength : 1 + strength))
      scoreGivenNotOutProbability = clampProbability(
        scoreGivenNotOutProbability * (favored ? 1 + strength : 1 - strength),
      )
    }

    if (Math.random() < outProbability) {
      outs += 1
    } else if (Math.random() < scoreGivenNotOutProbability) {
      if (battingHome) homeScore += 1
      else awayScore += 1
      scoringEvent = true
    }

    // Walk-off: home takes the lead DURING the bottom of the final/extra
    // inning — the game ends immediately, before necessarily reaching 3
    // outs, matching real baseball's "no need to bat further once already
    // ahead" rule.
    if (half === 'bottom' && inning >= totalInnings && homeScore > awayScore) {
      gameOver = true
    }

    if (!gameOver && outs === 3) {
      outs = 0
      if (half === 'top') {
        // Walk-off variant: home is ALREADY ahead going into the bottom of
        // the final (or, if a future change ever lets a real extra inning
        // play out, a later) inning — skip batting entirely, exactly as
        // real baseball does. Uses >=, matching the other two final-inning
        // checks in this function (below), rather than === — today `inning`
        // can never actually exceed `totalInnings` (a tie at the scheduled
        // length is force-decided by the nudge below rather than genuinely
        // continuing into a next inning), so the two are equivalent in
        // practice, but relying on that invariant holding via three
        // separately-written comparisons rather than one shared condition
        // is exactly the kind of thing a future change to the nudge (the
        // comments below already flag it as a simplification standing in
        // for real extra innings) could silently break — an adversarial
        // review flagged this inconsistency, fixed here defensively even
        // though it changes no current behavior.
        if (inning >= totalInnings && homeScore > awayScore) {
          gameOver = true
        } else {
          half = 'bottom'
        }
      } else {
        if (inning >= totalInnings) {
          if (homeScore !== awayScore) {
            gameOver = true
          } else {
            // Tied after the scheduled length — real baseball plays extra
            // innings until decided. The LIVE cosmetic game uses a cheap,
            // bounded nudge instead of actually simulating further innings
            // (mirroring soccer's own final-tick nudge safety net, for the
            // same reason: a bounded tick budget for the live/displayed
            // game), always by the smallest possible margin (1 run) so it
            // reads as a plausible extra-innings walk-off rather than a
            // jarring rewrite. drawResolvedMargin above, used only for the
            // ECONOMIC signal, is under no such tick-budget constraint and
            // DOES simulate real extra innings until decided.
            if (resolvedOutcome === 'win') homeScore = awayScore + 1
            else if (resolvedOutcome === 'loss') awayScore = homeScore + 1
            gameOver = true
          }
        } else {
          inning += 1
          half = 'top'
        }
      }
    }
  }

  return {
    state: {
      inning,
      half,
      outs,
      homeScore,
      awayScore,
      elapsedTicks: tickIndex + 1,
      opponentLevel,
      resolvedOutcome,
      resolvedMargin,
      totalInnings,
      gameOver,
    },
    scoringEvent,
  }
}

function isMatchComplete(state: BaseballMatchState): boolean {
  return state.gameOver === true
}

function rawOutcomeOf(state: BaseballMatchState): MatchOutcome {
  if (state.homeScore > state.awayScore) return 'win'
  if (state.homeScore === state.awayScore) return 'draw'
  return 'loss'
}

/** Same "one shared resolution path" pattern as soccer's resolvedOutcomeOf
 *  — see that function's doc comment in soccerModule.ts for the exact bug
 *  class this structurally prevents. */
function resolvedOutcomeOf(state: BaseballMatchState): MatchOutcome {
  return state.resolvedOutcome ?? rawOutcomeOf(state)
}

export function getOutcome(state: BaseballMatchState): MatchOutcome {
  return resolvedOutcomeOf(state)
}

/** Baseball's runs-differential analog to soccer's goal-differential margin
 *  — same role, same shape, just baseball's own vocabulary and its own
 *  independently-calibrated threshold (baseball's shorter, lower-scoring
 *  simplified games produce smaller typical differentials than soccer's
 *  90-tick matches, so this is NOT simply copied from soccer's value of 5).
 *  Directly simulated (2,000 dead-even-matchup games, measuring the real
 *  resolvedMargin — the economic signal, not the cosmetic live score) at
 *  this value: P(a win's margin >= 4) ~= 13%, a genuine minority of wins,
 *  matching soccer's own "rare blowout tail" calibration philosophy for
 *  its equivalent constant — see CLAUDE.md's "Baseball" amendment for the
 *  full verification writeup. */
const MAX_MEANINGFUL_RUN_DIFFERENTIAL = 4

/** Same drift-proof-preview reasoning and same resolvedMargin-over-live-
 *  score preference as soccer's getPerformanceFactor — see that function's
 *  doc comment in soccerModule.ts. Falls back to the raw live differential
 *  only when resolvedMargin was never drawn (no opponentLevelRange ever
 *  supplied for this match). */
export function getPerformanceFactor(state: BaseballMatchState): number {
  const diff = state.resolvedMargin ?? state.homeScore - state.awayScore
  const clamped = Math.max(
    -MAX_MEANINGFUL_RUN_DIFFERENTIAL,
    Math.min(MAX_MEANINGFUL_RUN_DIFFERENTIAL, diff),
  )
  return (clamped + MAX_MEANINGFUL_RUN_DIFFERENTIAL) / (2 * MAX_MEANINGFUL_RUN_DIFFERENTIAL)
}

/**
 * ticksPerMatch is a rough ESTIMATE only (see this file's top-of-file
 * design note and SportModule.ticksPerMatch's doc comment in
 * engine/types.ts) — isMatchComplete above is what's actually
 * authoritative. This MODULE-LEVEL value is a fallback only, representative
 * of the MIDDLE tier's length (6 innings, "Little League Nights") — it is
 * NOT accurate for the other two tiers (Tee Time's 3 innings, Varsity
 * Diamond's 7), since one shared SportModule instance has no idea which
 * tier's match it's advancing.
 *
 * An adversarial review caught this mattering more than "just an estimate"
 * plausibly implies: simulated at the real at-bat rates, Tee Time averages
 * ~28 ticks to complete (54% of this 52-tick value — its progress bar would
 * read barely-half-done at the moment the match actually ends and resets),
 * while Varsity Diamond averages ~61 ticks (117% of this value — its
 * progress bar would clamp at a false 100% for roughly the last 15% of the
 * match's real duration). Fixed by giving VentureCard.tsx an OPTIONAL
 * per-tier `estimatedTicksPerMatch` prop (see estimatedTicksForBaseballTier
 * below) that BaseballVentureCard.tsx always supplies — this module-level
 * constant now only matters as the SportModule interface's required
 * `ticksPerMatch` field, never actually read for the progress bar in
 * practice.
 */
export const BASEBALL_ESTIMATED_TICKS_PER_MATCH = 52

export function createBaseballModule(
  config: BaseballConfig = DEFAULT_BASEBALL_CONFIG,
): SportModule<BaseballMatchState> {
  return {
    id: 'baseball',
    ticksPerMatch: BASEBALL_ESTIMATED_TICKS_PER_MATCH,
    createInitialState,
    tick: (state, tickIndex, context) => tick(state, tickIndex, config, context),
    getOutcome,
    getPerformanceFactor,
    isMatchComplete,
  }
}

/**
 * Baseball's venture tiers. Phase 1 (see CLAUDE.md's "Baseball" amendment)
 * shipped a small 3-tier VALIDATION SLICE at real age-level innings counts.
 * Phase 2 (see CLAUDE.md's "Baseball: Phase 2" amendment) completes the REAL
 * side of the arc with three more real age/level tiers (college, minor
 * league, MLB) — a MECHANICAL CONTINUATION of the exact cost/multiplier
 * curve the first 3 tiers already established, not a new balance pass (same
 * treatment soccer's own tier 5-6 addition got in its eighth amendment).
 * Costs/multipliers were calibrated to feel roughly proportionate to
 * soccer's own early-tier curve, interleaved a bit further out than
 * soccer's equivalent depth (unlocking a whole SECOND sport is meant to
 * read as a bigger milestone than soccer's own next tier) — see CLAUDE.md
 * for the exact reasoning. Baseball's first tier does NOT start unlocked
 * (unlike soccer's local-game) — entering this sport at all is its own
 * deliberate purchase (see useGameStore.ts's createInitialBaseballTiers).
 *
 * The fictional grounded->epic->absurd arc beyond MLB (mirroring soccer's
 * own tiers 7-11) is NOT implemented here yet — it's a documented PROPOSAL
 * only (see CLAUDE.md), pending review before any tier configs are written.
 */
export const BASEBALL_VENTURE_TIERS: VentureTierConfig[] = [
  {
    id: 'tee-time',
    name: 'Tee Time',
    icon: '⚾',
    baseRevenueMultiplier: 20,
    unlockCost: 3000,
    managerHireCost: 3200,
    upgradeBaseCost: 1600,
    upgradeCostGrowth: 1.65,
  },
  {
    id: 'little-league-nights',
    name: 'Little League Nights',
    icon: '🏟️',
    baseRevenueMultiplier: 45,
    unlockCost: 15000,
    managerHireCost: 16000,
    upgradeBaseCost: 7000,
    upgradeCostGrowth: 1.7,
  },
  {
    id: 'varsity-diamond',
    name: 'Varsity Diamond',
    icon: '🎓',
    baseRevenueMultiplier: 130,
    unlockCost: 70000,
    managerHireCost: 75000,
    upgradeBaseCost: 27000,
    upgradeCostGrowth: 1.75,
  },
  // Phase 2's three new real tiers — see CLAUDE.md's "Baseball: Phase 2"
  // amendment for the exact ratio derivation. unlockCost/managerHireCost
  // continue the ~4.6-4.7x per-tier growth the first 3 tiers already
  // established (5.0x, 4.667x); upgradeBaseCost continues its own ~4x
  // convergence (4.375x, 3.857x); upgradeCostGrowth continues the flat
  // +0.05-per-tier pattern; baseRevenueMultiplier continues its own
  // (INCREASING, unlike soccer's decreasing one) ratio trend (2.25x,
  // 2.889x), stabilizing around ~3.1-3.25x — a faithful continuation of
  // baseball's OWN established curve, not an import of soccer's own
  // decreasing-ratio philosophy.
  {
    id: 'omaha-bound',
    name: 'Omaha Bound',
    icon: '🎒',
    baseRevenueMultiplier: 400,
    unlockCost: 325000,
    managerHireCost: 350000,
    upgradeBaseCost: 108000,
    upgradeCostGrowth: 1.8,
  },
  {
    id: 'triple-a-call-up',
    name: 'Triple-A Call-Up',
    icon: '⬆️',
    baseRevenueMultiplier: 1300,
    unlockCost: 1500000,
    managerHireCost: 1600000,
    upgradeBaseCost: 430000,
    upgradeCostGrowth: 1.85,
  },
  {
    id: 'the-show',
    name: 'The Show',
    icon: '🌟',
    baseRevenueMultiplier: 4200,
    unlockCost: 7000000,
    managerHireCost: 7500000,
    upgradeBaseCost: 1720000,
    upgradeCostGrowth: 1.9,
  },
]

/** Real age-level innings counts for each tier, indexed the same way as
 *  BASEBALL_VENTURE_TIERS — T-ball/rec-league games are commonly played
 *  over 3 innings, Little League over 6, high school (Varsity) over 7, and
 *  college/minor-league/MLB all over the full real 9 (see CLAUDE.md's
 *  "Baseball: Phase 2" amendment). Kept as a parallel array rather than a
 *  field on VentureTierConfig since inning count is baseball-specific
 *  vocabulary, not something the shared generic tier-config shape should
 *  know about (mirrors how soccer's opponent-level-range is ALSO computed
 *  from tierIndex externally, never stored on the tier config itself). */
export const BASEBALL_TIER_INNINGS = [3, 6, 7, 9, 9, 9]

export function inningsForBaseballTier(tierIndex: number): number {
  return BASEBALL_TIER_INNINGS[tierIndex] ?? BASEBALL_TIER_INNINGS[BASEBALL_TIER_INNINGS.length - 1]
}

/**
 * A real PER-TIER estimate of expected ticks-to-complete, for
 * VentureCard.tsx's progress bar (see its `estimatedTicksPerMatch` prop,
 * and BASEBALL_ESTIMATED_TICKS_PER_MATCH's own doc comment above for why
 * one flat module-level value materially misled the bar for two of the
 * three tiers). Same derivation as that constant (expected at-bats per
 * half-inning ~= 3 / average-out-probability, × 2 halves), just applied to
 * THIS tier's own real inning count instead of a fixed representative one.
 */
export function estimatedTicksForBaseballTier(
  tierIndex: number,
  config: BaseballConfig = DEFAULT_BASEBALL_CONFIG,
): number {
  const averageOutProbability = (config.homeOutProbability + config.awayOutProbability) / 2
  const expectedAtBatsPerHalfInning = 3 / averageOutProbability
  return Math.round(expectedAtBatsPerHalfInning * 2 * inningsForBaseballTier(tierIndex))
}
