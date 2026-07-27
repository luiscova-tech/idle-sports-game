// ============================================================
// src/engine/tickEngine.ts
// Sport-agnostic. No timers, no setInterval, no sport vocabulary — only
// ever calls methods on whatever SportModule<TState> it is given, plus the
// isolated economy module for revenue.
// ============================================================

import type { SportModule, TickResult, MatchResult } from './types'
import { calculateMatchRevenue } from './economy'

/** Pure helper: run one tick via the module. */
export function advanceTick<TState>(
  module: SportModule<TState>,
  state: TState,
  tickIndex: number,
): TickResult<TState> {
  return module.tick(state, tickIndex)
}

/** Pure helper: has this match run out of ticks? */
export function isMatchComplete<TState>(
  module: SportModule<TState>,
  tickIndexAfterTick: number,
): boolean {
  return tickIndexAfterTick >= module.ticksPerMatch
}

/** Pure helper: close out a finished match into an outcome + revenue. */
export function finalizeMatch<TState>(
  module: SportModule<TState>,
  finalState: TState,
): MatchResult<TState> {
  const outcome = module.getOutcome(finalState)
  const revenue = calculateMatchRevenue(outcome)
  return { finalState, outcome, revenue }
}
