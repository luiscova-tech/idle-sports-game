import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { advanceTick, isMatchComplete, finalizeMatch } from '../engine/tickEngine'
import type { MatchOutcome } from '../engine/types'
import {
  createSoccerModule,
  type SoccerMatchState,
  SOCCER_VENTURE_TIERS,
  tierUpgradeCost,
  tierPerTickRevenue,
} from '../sports/soccer/soccerModule'

// Single module-scoped instance of the currently plugged-in sport. Every
// venture tier below runs its own independent match through this same
// instance — only the payout multiplier differs per tier, never the sim
// itself. Later build-order steps may make the sport selectable; for v1
// there is only soccer.
const soccerModule = createSoccerModule()

export interface VentureTier {
  id: string
  unlocked: boolean
  /** "Improve Training" level — raises this tier's revenue multiplier. */
  level: number
  managerHired: boolean
  tickIndex: number
  match: SoccerMatchState
  matchesCompleted: number
  /** Lifetime Revenue earned FROM this tier specifically — tracked only to
   *  gate the next tier's unlock, not a separate currency (Revenue itself
   *  stays one global pool in `currencies`). */
  cumulativeRevenue: number
  lastOutcome: MatchOutcome | null
}

function createInitialTiers(): VentureTier[] {
  return SOCCER_VENTURE_TIERS.map((config, index) => ({
    id: config.id,
    unlocked: index === 0,
    level: 1,
    managerHired: false,
    tickIndex: 0,
    match: soccerModule.createInitialState(),
    matchesCompleted: 0,
    cumulativeRevenue: 0,
    lastOutcome: null,
  }))
}

// Re-checks every locked tier's unlock threshold against its immediately
// preceding tier's cumulative revenue. Called after every tick's tiers
// update (not only on match completion) — direct per-tick revenue now
// accrues into cumulativeRevenue on every tick, so a threshold can be
// crossed mid-match and must be picked up immediately, not just at the
// 90th tick.
function applyTierUnlocks(tiers: VentureTier[]): VentureTier[] {
  return tiers.map((tier, index) => {
    if (tier.unlocked || index === 0) return tier
    const priorTier = tiers[index - 1]
    const threshold = SOCCER_VENTURE_TIERS[index].unlockThreshold
    return priorTier.cumulativeRevenue >= threshold ? { ...tier, unlocked: true } : tier
  })
}

interface GameState {
  isInitialized: boolean
  tiers: VentureTier[]
  currencies: { revenue: number }
  tickTier: (tierId: string) => void
  upgradeTier: (tierId: string) => void
  hireManagerForTier: (tierId: string) => void
}

// Wrapped in zustand's persist middleware (localStorage) per CLAUDE.md's
// "client-side persistence for v1" — transparent to the tier/economy/engine
// logic below, which is unaware it's being saved. partialize keeps only
// actual game state in localStorage; actions are recreated fresh on load.
export const useGameStore = create<GameState>()(
  persist(
    (set, get) => ({
      isInitialized: true,
      tiers: createInitialTiers(),
      currencies: { revenue: 0 },

      // Advances one tier's match by exactly one tick, via the same
      // engine/economy path whether it's called from the idle interval
      // (useMatchTicker) or a manual "Push the Attack" click (VentureCard) —
      // there is no separate manual-resolution logic per tier.
      tickTier: (tierId) => {
        const { tiers } = get()
        const tierIndex = tiers.findIndex((t) => t.id === tierId)
        if (tierIndex === -1) return
        const tier = tiers[tierIndex]
        if (!tier.unlocked) return

        const { state: nextMatch } = advanceTick(soccerModule, tier.match, tier.tickIndex)
        const nextTickIndex = tier.tickIndex + 1

        // Direct per-tick Revenue: the primary generator, granted identically
        // whether this tick was triggered by a manual "Push the Attack" click
        // or the auto-play interval — same tickTier() path, no fork. This is
        // on top of (never instead of) the match-completion bonus below.
        const config = SOCCER_VENTURE_TIERS[tierIndex]
        const perTickRevenue = tierPerTickRevenue(config, tier.level)

        if (isMatchComplete(soccerModule, nextTickIndex)) {
          const { outcome, revenue: baseRevenue } = finalizeMatch(soccerModule, nextMatch)
          const completionBonus = Math.round(baseRevenue * config.baseRevenueMultiplier * tier.level)
          const totalEarned = perTickRevenue + completionBonus

          set((s) => {
            const updatedTiers = s.tiers.map((t, i) =>
              i === tierIndex
                ? {
                    ...t,
                    match: soccerModule.createInitialState(),
                    tickIndex: 0,
                    matchesCompleted: t.matchesCompleted + 1,
                    cumulativeRevenue: t.cumulativeRevenue + totalEarned,
                    lastOutcome: outcome,
                  }
                : t,
            )
            return {
              tiers: applyTierUnlocks(updatedTiers),
              currencies: { revenue: s.currencies.revenue + totalEarned },
            }
          })
        } else {
          set((s) => {
            const updatedTiers = s.tiers.map((t, i) =>
              i === tierIndex
                ? {
                    ...t,
                    match: nextMatch,
                    tickIndex: nextTickIndex,
                    cumulativeRevenue: t.cumulativeRevenue + perTickRevenue,
                  }
                : t,
            )
            return {
              tiers: applyTierUnlocks(updatedTiers),
              currencies: { revenue: s.currencies.revenue + perTickRevenue },
            }
          })
        }
      },

      // "Improve Training": spends Revenue to raise a tier's output multiplier
      // by one level. Cost grows per level (see tierUpgradeCost).
      upgradeTier: (tierId) => {
        const { tiers, currencies } = get()
        const tierIndex = tiers.findIndex((t) => t.id === tierId)
        if (tierIndex === -1) return
        const tier = tiers[tierIndex]
        if (!tier.unlocked) return
        const cost = tierUpgradeCost(SOCCER_VENTURE_TIERS[tierIndex], tier.level)
        if (currencies.revenue < cost) return

        set((s) => ({
          currencies: { revenue: s.currencies.revenue - cost },
          tiers: s.tiers.map((t, i) => (i === tierIndex ? { ...t, level: t.level + 1 } : t)),
        }))
      },

      // One-time purchase per tier: once hired, useMatchTicker starts
      // auto-ticking this tier specifically. No-op if already hired or
      // Revenue is insufficient.
      hireManagerForTier: (tierId) => {
        const { tiers, currencies } = get()
        const tierIndex = tiers.findIndex((t) => t.id === tierId)
        if (tierIndex === -1) return
        const tier = tiers[tierIndex]
        if (!tier.unlocked || tier.managerHired) return
        const cost = SOCCER_VENTURE_TIERS[tierIndex].managerHireCost
        if (currencies.revenue < cost) return

        set((s) => ({
          currencies: { revenue: s.currencies.revenue - cost },
          tiers: s.tiers.map((t, i) => (i === tierIndex ? { ...t, managerHired: true } : t)),
        }))
      },
    }),
    {
      name: 'idle-sports-game-save',
      partialize: (state) => ({ tiers: state.tiers, currencies: state.currencies }),
    },
  ),
)
