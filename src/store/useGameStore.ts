import { create } from 'zustand'
import { advanceTick, isMatchComplete, finalizeMatch } from '../engine/tickEngine'
import type { MatchOutcome } from '../engine/types'
import { createSoccerModule, type SoccerMatchState } from '../sports/soccer/soccerModule'

// Single module-scoped instance of the currently plugged-in sport. Later
// build-order steps may make this selectable; for v1 there is only soccer.
const soccerModule = createSoccerModule()

/** One-time Revenue cost to unlock auto-play. This is a store/UI-level idle
 *  mechanic ("pay currency to unlock automation"), not part of the
 *  match-outcome economy every sport module shares — so it lives here
 *  rather than in the sport-agnostic src/engine/economy.ts. */
export const MANAGER_HIRE_COST = 150

interface GameState {
  isInitialized: boolean
  tickIndex: number
  match: SoccerMatchState
  matchesCompleted: number
  currencies: { revenue: number }
  lastOutcome: MatchOutcome | null
  autoPlayUnlocked: boolean
  tick: () => void
  hireManager: () => void
}

export const useGameStore = create<GameState>((set, get) => ({
  isInitialized: true,
  tickIndex: 0,
  match: soccerModule.createInitialState(),
  matchesCompleted: 0,
  currencies: { revenue: 0 },
  lastOutcome: null,
  autoPlayUnlocked: false,

  // Advances the match by exactly one tick, via the same engine/economy path
  // whether it's called from the idle interval (useMatchTicker) or from a
  // manual "Push the Attack" click (MatchControls) — there is no separate
  // manual-resolution logic to keep in sync.
  tick: () => {
    const { tickIndex, match } = get()
    const { state: nextMatch } = advanceTick(soccerModule, match, tickIndex)
    const nextTickIndex = tickIndex + 1

    if (isMatchComplete(soccerModule, nextTickIndex)) {
      const { outcome, revenue } = finalizeMatch(soccerModule, nextMatch)
      set((s) => ({
        match: soccerModule.createInitialState(),
        tickIndex: 0,
        matchesCompleted: s.matchesCompleted + 1,
        currencies: { revenue: s.currencies.revenue + revenue },
        lastOutcome: outcome,
      }))
    } else {
      set({ match: nextMatch, tickIndex: nextTickIndex })
    }
  },

  // One-time purchase: once unlocked, useMatchTicker starts running the
  // idle interval. No-op if already unlocked or Revenue is insufficient.
  hireManager: () => {
    const { autoPlayUnlocked, currencies } = get()
    if (autoPlayUnlocked || currencies.revenue < MANAGER_HIRE_COST) return
    set((s) => ({
      autoPlayUnlocked: true,
      currencies: { revenue: s.currencies.revenue - MANAGER_HIRE_COST },
    }))
  },
}))
