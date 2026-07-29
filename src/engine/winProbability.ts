// ============================================================
// src/engine/winProbability.ts
// Sport-agnostic level-gap-driven win/draw/loss probability model. Any
// sport module whose match outcome should be decided by a continuous,
// opponent-level-based probability curve (rather than a hard "below this
// level, a win is impossible" cliff) reuses this directly — the formula
// only ever consumes two plain numbers (a player level and an opponent
// level), never sport-specific state, so a second sport module has no
// reason to reimplement it.
//
// HISTORY: originally developed and validated for soccer (see CLAUDE.md's
// "Continuous win-probability model" amendment — S=4 reproduces the
// validated anchor point of a 3-level gap -> ~15.1% win chance). Hoisted
// out of src/sports/soccer/soccerModule.ts into this shared file when
// baseball needed the exact same math (see CLAUDE.md's "Baseball" amendment)
// — this project has a real, repeated bug history from duplicated formulas
// silently drifting apart (getPerformanceFactor leaking a margin bonus into
// a downgraded outcome, not once but twice, across the thirteenth and
// fifteenth amendments), so this file exists specifically to make that
// class of bug structurally impossible for this one formula going forward:
// there is now exactly one copy of it, and every sport module calls it.
// ============================================================

import type { MatchOutcome } from './types'

/** How sharply win probability falls off per level of gap. S=4 reproduces
 *  the validated anchor point (a 3-level gap -> ~15.1% win chance) by
 *  construction, not by simulation-fitting. */
const GAP_PROBABILITY_SCALE = 4

/**
 * How much of the non-win probability mass becomes a draw (the rest is a
 * loss), as a fraction of `closeness * (1 - pWin)`, where `closeness =
 * 4 * pWin * (1 - pWin)` peaks at 1 when the match is dead-even (pWin=0.5)
 * and tapers to 0 at extreme mismatches — draws are commonest in close
 * matchups and rare in blowouts, in either direction. Chosen so pDraw can
 * mathematically never exceed `1 - pWin`, at any pWin — no clamping needed,
 * safe by construction.
 */
const DRAW_WEIGHT = 0.5

/**
 * The pure win/draw/loss probability triple for a given player/opponent
 * level gap. Mathematically incapable of reaching exactly 0% or 100% at any
 * finite gap — "never truly impossible, however small" holds by
 * construction, no floor/ceiling clamp needed.
 */
export function matchOutcomeProbabilities(
  playerLevel: number,
  opponentLevel: number,
): Record<MatchOutcome, number> {
  const gap = opponentLevel - playerLevel
  const pWin = 1 / (1 + 10 ** (gap / GAP_PROBABILITY_SCALE))
  const closeness = 4 * pWin * (1 - pWin)
  const pDraw = DRAW_WEIGHT * closeness * (1 - pWin)
  return { win: pWin, draw: pDraw, loss: 1 - pWin - pDraw }
}

/** Resolves a single match outcome via one direct roll against
 *  matchOutcomeProbabilities — intended to be called exactly once per
 *  match, early (e.g. at tick 0), with the result stored in the sport
 *  module's own opaque state so later getOutcome()/getPerformanceFactor()
 *  calls can read it back out idempotently rather than re-rolling. */
export function resolveMatchOutcome(playerLevel: number, opponentLevel: number): MatchOutcome {
  const { win, draw } = matchOutcomeProbabilities(playerLevel, opponentLevel)
  const roll = Math.random()
  if (roll < win) return 'win'
  if (roll < win + draw) return 'draw'
  return 'loss'
}

/**
 * Some sports have no draw state at all — real baseball plays extra innings
 * until decided, never ending in a tie. This collapses
 * matchOutcomeProbabilities' draw probability mass proportionally into
 * win/loss (the same technique real sports-betting markets use for a
 * "no draw" / money-line price), so a sport module that needs a guaranteed
 * win-or-loss result reuses the exact same underlying win/loss RATIO
 * rather than inventing a second, parallel probability formula. */
export function matchOutcomeProbabilitiesWithoutDraw(
  playerLevel: number,
  opponentLevel: number,
): { win: number; loss: number } {
  const { win, loss } = matchOutcomeProbabilities(playerLevel, opponentLevel)
  const total = win + loss
  return { win: win / total, loss: loss / total }
}

/** Resolves a guaranteed win-or-loss outcome (never 'draw') via one direct
 *  roll against matchOutcomeProbabilitiesWithoutDraw — see that function's
 *  doc comment for why a sport with no draw state reuses this rather than a
 *  separate formula. */
export function resolveMatchOutcomeWithoutDraw(
  playerLevel: number,
  opponentLevel: number,
): 'win' | 'loss' {
  const { win } = matchOutcomeProbabilitiesWithoutDraw(playerLevel, opponentLevel)
  return Math.random() < win ? 'win' : 'loss'
}
