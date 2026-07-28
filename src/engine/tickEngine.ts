// ============================================================
// src/engine/tickEngine.ts
// Sport-agnostic. No timers, no setInterval, no sport vocabulary — only
// ever calls methods on whatever SportModule<TState> it is given, plus the
// isolated economy module for revenue.
// ============================================================

import type { SportModule, TickResult, MatchResult, MatchContext } from './types'
import { calculateMatchRevenue } from './economy'

/** Pure helper: run one tick via the module. `context` is optional and
 *  passed straight through — this file never inspects it, only a sport
 *  module may. */
export function advanceTick<TState>(
  module: SportModule<TState>,
  state: TState,
  tickIndex: number,
  context?: MatchContext,
): TickResult<TState> {
  return module.tick(state, tickIndex, context)
}

/** Pure helper: has this match run out of ticks? */
export function isMatchComplete<TState>(
  module: SportModule<TState>,
  tickIndexAfterTick: number,
): boolean {
  return tickIndexAfterTick >= module.ticksPerMatch
}

/** Pure helper: close out a finished match into an outcome + revenue.
 *  `context` (see MatchContext) is optional and only ever consumed by the
 *  sport module's own getOutcome() — this file stays unaware of what it
 *  means. Revenue scales with both the outcome category AND the module's
 *  own generic 0-1 performance factor (see calculateMatchRevenue/
 *  getPerformanceFactor) — this file never sees the sport-specific stats
 *  (goals, etc.) behind that factor. */
export function finalizeMatch<TState>(
  module: SportModule<TState>,
  finalState: TState,
  context?: MatchContext,
): MatchResult<TState> {
  const outcome = module.getOutcome(finalState, context)
  const performanceFactor = module.getPerformanceFactor(finalState, context)
  const revenue = calculateMatchRevenue(outcome, performanceFactor)
  return { finalState, outcome, revenue }
}
