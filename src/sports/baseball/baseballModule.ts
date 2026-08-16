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
import { type VentureTierConfig, scaledTierConfigs } from '../../engine/ventureTiers'

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

/**
 * ── THE COSMETIC SCORE BOUNDS ──
 * These two constants bound the DISPLAYED score only. They are deliberately
 * separate from MAX_MEANINGFUL_RUN_DIFFERENTIAL, which bounds the ECONOMIC
 * signal (`resolvedMargin`, drawn by the fully-independent, fully-unbiased
 * drawResolvedMargin above) — that path already had correct protection and is
 * not touched by anything here.
 *
 * WHY THIS WAS NEEDED: the bias ramp below multiplies the favoured side's out
 * probability by `1 - strength`, and `strength` reaches SCORE_BIAS_STRENGTH
 * (1.2) late in a game — which is NEGATIVE, so it pinned the out probability
 * at BIASED_PROBABILITY_MIN (0.02). At a 2% out probability a half-inning
 * needs ~150 at-bats to reach three outs, and the favoured side scores on most
 * of them. Measured against the real module before this fix: a 9-inning game
 * averaged a **153-run** differential and peaked at **598-0**, with games
 * running 876 at-bats against an estimate of 78. That is what produced the
 * implausible scorelines visible on screen.
 *
 * COMFORTABLE_COSMETIC_LEAD is the real fix, and it is a shape fix rather than
 * a clamp: the bias exists to ESTABLISH the correct winner, not to run up the
 * score, so it switches off entirely once the favoured side is that far ahead,
 * and back on if the lead is lost. Unbiased play is symmetric, so a held lead
 * wobbles rather than compounding.
 *
 * The VALUE is 2, and it is load-bearing in a way a first pass missed. Because
 * the bias keeps pushing until the favoured side leads by this much, a final
 * margin SMALLER than it is structurally impossible — at 3, one-run games
 * simply stopped existing (measured: 0.1% of 9-inning games, against ~28% of
 * real MLB games decided by a single run). An adversarial review caught that,
 * and it is exactly the kind of distribution defect a "max" bound alone would
 * never reveal. Swept 1/2/3 over 20,000 games each; 2 is the balance point:
 *
 *   value | mean |diff| | 1-run games | mean runs | end-of-game corrections
 *       1 |       2.44  |      39.0%  |      9.4  | 7.6%  (visible rewrites)
 *       2 |       3.18  |      13.7%  |      9.6  | 0.01%
 *       3 |       4.12  |       0.1%  |     10.2  | 0.00%
 *
 * At 2 the mean margin (3.18) and total runs (9.6) both land essentially on
 * real MLB figures (~3.2 and ~8-9), and the score-correction path below
 * effectively never fires. 1 gets one-run games closest to reality but pays
 * for it with a visible end-of-game rewrite in ~1 game in 13, which is the
 * very jank the bias exists to avoid. HONEST LIMITATION: 13.7% one-run games
 * still under-represents MLB's ~28%. That is inherent to guaranteeing the
 * winner via a bias at all, and is accepted rather than hidden.
 *
 * Game length also lands on the pre-existing estimatedTicksForBaseballTier
 * figures (77.7 measured vs 78 for 9 innings, 25.4 vs 26 for 3) — see
 * CLAUDE.md for why that agreement matters beyond the progress bar.
 *
 * MAX_COSMETIC_RUN_DIFFERENTIAL is a belt-and-braces hard ceiling. With the
 * gate above it binds only in the far tail — measured maxima are 7 (3 inn),
 * 13 (7 inn) and 14 (9 inn) over 5,000 games each, with an occasional 15 in
 * larger samples, so it is a genuine bound rather than decoration, and an
 * earlier draft of this comment claiming it "should essentially never bind"
 * understated it (adversarial review).
 * 15 is anchored to real baseball rather than picked: it is exactly the
 * early-innings mercy-rule threshold used across amateur ball (15 runs after
 * 3-4 innings in Little League and high school, alongside the more common
 * 10-after-4-or-5), it is a routine-but-notable MLB blowout, and it sits far
 * below the modern record margin of 27 (Rangers 30-3 over the Orioles, 22 Aug
 * 2007 — the only 30-run game in MLB history) so the game can never look like
 * it is breaking an all-time record every match.
 */
const COMFORTABLE_COSMETIC_LEAD = 2
const MAX_COSMETIC_RUN_DIFFERENTIAL = 15

function clampProbability(p: number): number {
  return Math.min(BIASED_PROBABILITY_MAX, Math.max(BIASED_PROBABILITY_MIN, p))
}

/**
 * Whether HOME being ahead is consistent with the already-resolved outcome —
 * i.e. whether a home walk-off may legitimately end the game.
 *
 * Both walk-off exits below fire purely on `homeScore > awayScore`, so without
 * this a resolved LOSS could be ended by the home side happening to be ahead
 * at the final inning, freezing a final score that contradicts the outcome
 * badge beside it. Empirically that never happened across 63,000 measured
 * games (the bias makes a resolved loser leading late very unlikely), but it
 * was reachable BY CONSTRUCTION rather than prevented, and this project has
 * shipped that exact display/outcome inconsistency class before. An
 * adversarial review flagged it; closing it costs one comparison and makes the
 * sign guarantee absolute rather than merely probable. When the outcome was
 * never resolved (no opponentLevelRange supplied), any winner is consistent.
 */
function homeLeadEndsGame(resolvedOutcome: MatchOutcome | undefined): boolean {
  return resolvedOutcome === undefined || resolvedOutcome === 'win'
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

    // The favoured side's CURRENT lead, which gates the bias below. See
    // COMFORTABLE_COSMETIC_LEAD: the bias is there to establish the correct
    // winner, not to run up the score, so it switches off once that side is
    // comfortably ahead — and back on if the lead is given up.
    const favouredLead =
      favorsHome === null ? 0 : favorsHome ? homeScore - awayScore : awayScore - homeScore

    if (favorsHome !== null && favouredLead < COMFORTABLE_COSMETIC_LEAD) {
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
      // The hard ceiling (MAX_COSMETIC_RUN_DIFFERENTIAL): a side already
      // ahead by the maximum plausible margin cannot extend it further. Only
      // ever suppresses EXTENDING a lead — a trailing side scoring always
      // counts, since that shrinks the differential. It cannot interfere with
      // the walk-off below either, which fires on TAKING the lead, a state
      // this can never block.
      const battingLead = battingHome ? homeScore - awayScore : awayScore - homeScore
      if (battingLead < MAX_COSMETIC_RUN_DIFFERENTIAL) {
        if (battingHome) homeScore += 1
        else awayScore += 1
        scoringEvent = true
      }
    }

    // Walk-off: home takes the lead DURING the bottom of the final/extra
    // inning — the game ends immediately, before necessarily reaching 3
    // outs, matching real baseball's "no need to bat further once already
    // ahead" rule.
    if (
      half === 'bottom' &&
      inning >= totalInnings &&
      homeScore > awayScore &&
      homeLeadEndsGame(resolvedOutcome)
    ) {
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
        if (inning >= totalInnings && homeScore > awayScore && homeLeadEndsGame(resolvedOutcome)) {
          gameOver = true
        } else {
          half = 'bottom'
        }
      } else {
        if (inning >= totalInnings) {
          // End of regulation. The displayed score must agree in SIGN with
          // resolvedOutcome, which is what actually decides the payout and
          // what the Last Result badge shows — a final score contradicting
          // the reported result is exactly the display/outcome inconsistency
          // this project already had to fix once for soccer.
          //
          // Two cases need correcting, not one. A TIE is the obvious one:
          // real baseball plays extra innings until decided, and the LIVE
          // cosmetic game uses a cheap bounded nudge instead of simulating
          // them (mirroring soccer's own final-tick nudge, for the same
          // reason: a bounded tick budget for the displayed game), always by
          // the smallest possible margin (1 run) so it reads as a plausible
          // extra-innings walk-off rather than a jarring rewrite.
          //
          // The WRONG SIDE AHEAD is the second, and was previously unhandled:
          // the old code ended the game on any non-tie, so a cosmetic score
          // that had drifted against the resolved outcome was simply
          // displayed as-is, contradicting the badge beside it. That was
          // near-unreachable before, because the unbounded bias made the
          // favoured side run away with every game; bounding the score (see
          // COMFORTABLE_COSMETIC_LEAD) makes ordinary close games reachable,
          // so it is handled explicitly rather than left to a property the
          // bias no longer guarantees. Same minimal 1-run correction, which
          // reads as a plausible late comeback.
          const favouredIsHome = scoreBiasFavorsHome(resolvedOutcome)
          const signAgrees =
            favouredIsHome === null
              ? homeScore !== awayScore
              : favouredIsHome
                ? homeScore > awayScore
                : awayScore > homeScore
          if (signAgrees) {
            gameOver = true
          } else {
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
 *  Directly simulated (dead-even matchups, measuring the real resolvedMargin
 *  — the economic signal, not the cosmetic live score). RE-MEASURED at
 *  20,000 games per inning-count, because the original "~13%" figure written
 *  here dated from baseball's 3-tier Phase 1 slice and went stale when the
 *  ladder grew to 11 tiers of which eight are 9-inning: the rate rises with
 *  game length, since a longer game has more innings in which to build a
 *  lead. P(a win's margin >= 4) is 2.5% at 3 innings, 11.9% at 6, 15.1% at
 *  7 and 22.6% at 9 — a ladder-weighted 19.1% overall. Still a genuine
 *  minority of wins, so the "rare blowout tail" philosophy this shares with
 *  soccer's equivalent constant holds; the stale number understated it.
 *  This constant and everything it feeds are DELIBERATELY untouched by the
 *  cosmetic score bounds above — verified by measuring these same rates
 *  against the committed pre-fix module and getting the same figures within
 *  noise (22.28% vs 22.43% at 9 innings). */
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
 * How many seconds of the player's CURRENT aggregate income rate baseball's
 * FIRST tier (Tee Time) unlockCost should represent, when baseball's whole
 * cost ladder is re-anchored to the player's economic reality (see
 * CLAUDE.md's "Income-rate-anchored entry costs" convention and
 * useGameStore.ts's `SCHEMA_MIGRATIONS[5]` / `incomeRateAnchorMultiplier`).
 *
 * 60s chosen deliberately: entering a whole second sport should read as "a
 * real commitment" — about one full minute of your current combined
 * earning power just to unlock the entry tier — not the fraction-of-a-
 * second triviality that fixed absolute numbers became for a wealthy,
 * soccer-rich player (the actual reported problem). It is NOT so large as to
 * be a wall: one minute of income is plainly surmountable, and the ~4.6x
 * per-tier growth already baked into BASEBALL_VENTURE_TIERS below then
 * compounds that entry anchor into a genuinely steep late-game ladder on its
 * own, exactly as the original design intended — this only relocates the
 * ladder's absolute starting point to match the player, it never changes its
 * shape (upgradeCostGrowth and every tier-to-tier ratio are preserved
 * unscaled). Tunable in one place if the entry commitment should feel
 * heavier/lighter; documented rather than magic so a future session knows
 * it's a deliberate knob.
 *
 * This constant lives in baseball's own module (not the store) because "how
 * big a commitment is entering THIS sport" is a per-sport design decision —
 * a future third sport picks its own anchor-seconds the same way, per the
 * standing convention.
 */
export const BASEBALL_COST_ANCHOR_SECONDS = 60

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
 * own tiers 7-11) — proposed for review in the "Baseball: Phase 2" amendment
 * — is now implemented below (mudville-miracle through
 * the-interdimensional-series), per the follow-up session that approved and
 * calibrated it (see CLAUDE.md's "Baseball: fictional tiers" amendment).
 * Unlike soccer's tiers 7-11, NONE of baseball's tiers — real or fictional —
 * are prestige-gated: every one remains directly Revenue-purchasable, per
 * this project's confirmed design decision to keep baseball fully
 * independent of the Legacy/prestige system.
 *
 * IMPORTANT — the three COST fields below (unlockCost/managerHireCost/
 * upgradeBaseCost) are now the REFERENCE CURVE (the ladder's cost SHAPE),
 * not necessarily the numbers a given player is charged. As of the
 * "Income-rate-anchored entry costs" amendment (see CLAUDE.md), a save
 * carries a `baseballCostAnchorMultiplier` and the LIVE costs a player is
 * charged/shown are `scaledBaseballTiers(multiplier)` — ONLY those three
 * cost fields multiplied by that per-save anchor, which was derived once
 * from the player's own aggregate income rate so entering the sport reads
 * as a real commitment relative to THEIR economy rather than a fixed
 * absolute that a soccer-rich player finds trivial. A multiplier of 1 (a
 * fresh save, or the floor case) means these reference cost numbers ARE the
 * live costs, unchanged. Tier-to-tier cost ratios are preserved by the
 * scaling — only the absolute starting point moves — so the ~4.6-4.7x
 * growth documented below still describes the live ladder's cost shape
 * exactly.
 *
 * `baseRevenueMultiplier` below is NEVER scaled by the anchor, at any
 * multiplier — see `scaledTierConfigs`' own doc comment (ventureTiers.ts)
 * for the real bug this project shipped and fixed by that exclusion. This
 * tier list's `baseRevenueMultiplier` values are the ONLY values baseball's
 * revenue is ever computed from, for every player, regardless of wealth.
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
  // The five fictional tiers (grounded-legend -> sci-fi -> mythic -> eternal
  // -> cosmic), proposed for review in the "Baseball: Phase 2" CLAUDE.md
  // amendment and approved/implemented in this session. Numbers continue
  // BASEBALL'S OWN established ratio bands (see the six real tiers' own
  // ratio derivation above this array) — NOT soccer's flat/decreasing-ratio
  // continuation — validated via simulation before finalizing (see
  // CLAUDE.md's "Baseball: fictional tiers" amendment for the full
  // derivation and pacing-check results):
  //   - unlockCost/managerHireCost: continue oscillating in the exact
  //     4.6-4.7x band the six real tiers already established (4.643, 4.615,
  //     4.667, 4.643, 4.615 for unlockCost; 4.667, 4.571, 4.6875, 4.667,
  //     4.571 for managerHireCost) — chosen as clean round numbers landing
  //     in that band, not a single flat ratio.
  //   - upgradeBaseCost: continues the ~4.0x convergence exactly (flat 4.0x
  //     for all five, matching the last three real tiers' own 4.0/3.981/4.0).
  //   - upgradeCostGrowth: continues the flat +0.05-per-tier pattern.
  //   - baseRevenueMultiplier: holds at baseball's own stabilized ~3.2x
  //     plateau (3.077x/3.25x/3.231x for the last three real tiers) rather
  //     than still climbing or importing soccer's decreasing-ratio approach.
  {
    id: 'mudville-miracle',
    name: 'The Mudville Miracle',
    icon: '🎩',
    baseRevenueMultiplier: 13500,
    unlockCost: 32500000,
    managerHireCost: 35000000,
    upgradeBaseCost: 6880000,
    upgradeCostGrowth: 1.95,
  },
  {
    id: 'lunar-league-nights',
    name: 'Lunar League Nights',
    icon: '🌕',
    baseRevenueMultiplier: 43000,
    unlockCost: 150000000,
    managerHireCost: 160000000,
    upgradeBaseCost: 27520000,
    upgradeCostGrowth: 2.0,
  },
  {
    id: 'home-run-derby-of-the-gods',
    name: 'Home Run Derby of the Gods',
    icon: '⚡',
    baseRevenueMultiplier: 138000,
    unlockCost: 700000000,
    managerHireCost: 750000000,
    upgradeBaseCost: 110080000,
    upgradeCostGrowth: 2.05,
  },
  {
    id: 'the-eternal-inning',
    name: 'The Eternal Inning',
    icon: '⏳',
    baseRevenueMultiplier: 442000,
    unlockCost: 3250000000,
    managerHireCost: 3500000000,
    upgradeBaseCost: 440320000,
    upgradeCostGrowth: 2.1,
  },
  {
    id: 'the-interdimensional-series',
    name: 'The Interdimensional Series',
    icon: '🌀',
    baseRevenueMultiplier: 1415000,
    unlockCost: 15000000000,
    managerHireCost: 16000000000,
    upgradeBaseCost: 1761280000,
    upgradeCostGrowth: 2.15,
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
 *  from tierIndex externally, never stored on the tier config itself).
 *
 *  The five fictional tiers (mudville-miracle through
 *  the-interdimensional-series) all stay at the real MLB-regulation 9 —
 *  per this session's own instruction, they escalate cost/multiplier
 *  numbers only, introducing no new match-resolution mechanic (an actual
 *  "infinite innings" rule for The Eternal Inning would be exactly that, so
 *  it stays a name/theme, not a mechanic). */
export const BASEBALL_TIER_INNINGS = [3, 6, 7, 9, 9, 9, 9, 9, 9, 9, 9]

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

/**
 * Baseball's LIVE tier config ladder for a given per-save anchor multiplier:
 * `BASEBALL_VENTURE_TIERS` (the reference curve above) rescaled by
 * `anchorMultiplier` via the shared, sport-agnostic `scaledTierConfigs`
 * (engine/ventureTiers.ts). See CLAUDE.md's "Income-rate-anchored entry
 * costs" convention.
 *
 * This is the ONE authoritative place every consumer of baseball's ACTUAL
 * costs derives from — the store's baseball actions AND income aggregation,
 * and BaseballVentureCard.tsx's displayed costs — so the anchor can never be
 * applied inconsistently (charged one way, displayed another). A multiplier
 * of exactly `1` (a brand-new save, or any save predating this convention)
 * reproduces `BASEBALL_VENTURE_TIERS` byte-for-byte: a pure pass-through, not
 * a behavior change. `id`/`name`/`icon`/`upgradeCostGrowth` are unchanged;
 * only the three COST fields (unlockCost, managerHireCost, upgradeBaseCost)
 * are scaled — `baseRevenueMultiplier` is DELIBERATELY excluded (see
 * `scaledTierConfigs`' own doc comment for the real bug this project shipped
 * and fixed by that exclusion: revenue must never scale with the player's
 * wealth, only cost does).
 */
export function scaledBaseballTiers(anchorMultiplier: number): VentureTierConfig[] {
  return scaledTierConfigs(BASEBALL_VENTURE_TIERS, anchorMultiplier)
}
