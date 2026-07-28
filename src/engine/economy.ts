// ============================================================
// src/engine/economy.ts
// Isolated economy module (CLAUDE.md: save/economy logic lives on its own,
// not scattered across UI or sport code). Sport-agnostic: keyed only on the
// generic MatchOutcome, so every sport module shares this pricing table
// without redefining it.
// ============================================================

import type { MatchOutcome } from './types'

const REVENUE_BY_OUTCOME: Record<MatchOutcome, number> = {
  win: 100,
  draw: 40,
  loss: 15,
}

/** Extra revenue at the most decisive possible result, as a fraction of
 *  that outcome's own base payout — so the bonus stays a consistent
 *  fraction of the base at every venture tier (the store multiplies this
 *  function's whole return value by the tier's own multiplier afterward,
 *  same as it already does for the flat base). */
const MAX_MARGIN_BONUS_FRACTION = 0.6

/**
 * Revenue for a completed match, scaled by BOTH its outcome category and how
 * decisive it was. `performanceFactor` is the sport module's generic 0-1
 * signal (see SportModule.getPerformanceFactor in types.ts): 0 = the most
 * lopsided possible loss, 0.5 = neutral (a draw always sits exactly here),
 * 1 = the most decisive possible win. This file never learns what produces
 * that number (goals, sets, whatever) — only the generic scale.
 *
 * The bonus only ever applies ABOVE neutral (factor > 0.5) and only ever
 * adds on top of the flat base — it never reduces revenue below the
 * outcome's own base payout. That's deliberate: a decisive win should pay
 * more, but a decisive LOSS must never pay more than a narrow one, or a
 * player would be financially rewarded for deliberately losing badly.
 */
export function calculateMatchRevenue(outcome: MatchOutcome, performanceFactor: number): number {
  const base = REVENUE_BY_OUTCOME[outcome]
  const decisiveness = Math.max(0, (performanceFactor - 0.5) * 2)
  return Math.round(base * (1 + MAX_MARGIN_BONUS_FRACTION * decisiveness))
}

/**
 * Generic, outcome-INDEPENDENT expected value: sum over every possible
 * MatchOutcome of (its probability × its payout at a NEUTRAL performance
 * factor). Takes only a probability triple — never an actual match state —
 * so by construction there is nothing here that could read or leak which
 * outcome a specific match actually resolved to; the same (win, draw, loss)
 * probabilities always produce the exact same number, regardless of what
 * any individual match rolls.
 *
 * Neutral factor (0.5) is used for every outcome. This is mathematically
 * EXACT for draw and loss — this file's own decisiveness formula above
 * clamps to 0 at or below the neutral factor, so neither outcome's true
 * average payout ever differs from its flat base. It is a deliberate,
 * honest LOWER BOUND for win specifically: a win's true average payout
 * includes a real margin-bonus premium (see CLAUDE.md's calibration
 * history), but computing that premium's expectation would require either
 * a second, separately-maintained statistical model of the margin
 * distribution — reintroducing exactly the "two copies of the same math
 * drift apart" bug class this project has been bitten by more than once —
 * or live random sampling at render time, which would make this value
 * non-deterministic (flickering between renders) and is unnecessary when a
 * clean, honest closed form is available. Reuses calculateMatchRevenue
 * directly for all three terms rather than reading REVENUE_BY_OUTCOME or
 * the bonus formula separately, so this stays automatically correct if
 * either ever changes.
 */
export function expectedMatchRevenue(probabilities: Record<MatchOutcome, number>): number {
  const NEUTRAL_FACTOR = 0.5
  return (
    probabilities.win * calculateMatchRevenue('win', NEUTRAL_FACTOR) +
    probabilities.draw * calculateMatchRevenue('draw', NEUTRAL_FACTOR) +
    probabilities.loss * calculateMatchRevenue('loss', NEUTRAL_FACTOR)
  )
}
