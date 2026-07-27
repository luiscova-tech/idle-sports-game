import { create } from 'zustand'
import { advanceTick, isMatchComplete, finalizeMatch } from '../engine/tickEngine'
import type { MatchOutcome } from '../engine/types'
import { createSoccerModule, type SoccerMatchState } from '../sports/soccer/soccerModule'

// Single module-scoped instance of the currently plugged-in sport. Later
// build-order steps may make this selectable; for v1 there is only soccer.
const soccerModule = createSoccerModule()

interface GameState {
  isInitialized: boolean
  tickIndex: number
  match: SoccerMatchState
  matchesCompleted: number
  currencies: { revenue: number }
  lastOutcome: MatchOutcome | null
  tick: () => void
}

export const useGameStore = create<GameState>((set, get) => ({
  isInitialized: true,
  tickIndex: 0,
  match: soccerModule.createInitialState(),
  matchesCompleted: 0,
  currencies: { revenue: 0 },
  lastOutcome: null,

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
}))
