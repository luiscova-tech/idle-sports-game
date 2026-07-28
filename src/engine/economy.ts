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
