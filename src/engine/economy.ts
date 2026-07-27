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

export function calculateMatchRevenue(outcome: MatchOutcome): number {
  return REVENUE_BY_OUTCOME[outcome]
}
