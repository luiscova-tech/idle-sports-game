import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { advanceTick, isMatchComplete, finalizeMatch } from '../engine/tickEngine'
import type { MatchOutcome } from '../engine/types'
import {
  calculateLegacyPoints,
  createInitialPermanentUpgrades,
  globalRevenueMultiplier,
  unlockCostMultiplier,
  startingRevenue,
  startingUnlockedTierCount,
  PERMANENT_UPGRADES,
  type PermanentUpgradeLevels,
} from '../engine/prestige'
import {
  createSoccerModule,
  type SoccerMatchState,
  SOCCER_VENTURE_TIERS,
  tierUpgradeCost,
  tierPerTickRevenue,
  FIRST_PRESTIGE_TRIGGER_TIER_ID,
  isTierRevealed,
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
  /** Lifetime Revenue earned FROM this tier specifically — an informational
   *  stat only. Unlocking the next tier is a deliberate purchase from the
   *  player's current spendable balance (see unlockTier), not gated on
   *  this; Revenue itself stays one global pool in `currencies`. */
  cumulativeRevenue: number
  lastOutcome: MatchOutcome | null
}

// Takes the currently-owned permanent upgrades so a prestige reset (which
// keeps those upgrades) and the very first-ever game start (which has none
// yet) both produce a correctly-configured fresh ladder via the same path —
// never two divergent "fresh tiers" implementations.
function createInitialTiers(permanentUpgrades: PermanentUpgradeLevels): VentureTier[] {
  const preUnlockedCount = startingUnlockedTierCount(permanentUpgrades)
  return SOCCER_VENTURE_TIERS.map((config, index) => ({
    id: config.id,
    unlocked: index < preUnlockedCount,
    level: 1,
    managerHired: false,
    tickIndex: 0,
    match: soccerModule.createInitialState(),
    matchesCompleted: 0,
    cumulativeRevenue: 0,
    lastOutcome: null,
  }))
}

export interface LegacyState {
  /** Permanent, never reset by resetForLegacy(). Spendable currency earned
   *  by prestiging — its own currency type, cleanly separated from Revenue. */
  legacyPoints: number
  /** True forever once the player has prestiged at least once. Gates
   *  whether tiers 7-11 (`legends-circuit` onward) exist/render in the UI
   *  at all — see `TIERS_REVEALED_BEFORE_PRESTIGE` in `soccerModule.ts` and
   *  `Home.tsx`. Once true it never reverts on a `resetForLegacy()` reset
   *  (that's the whole point — the reveal is permanent), only on a full
   *  `resetProgress()` wipe. */
  hasPrestiged: boolean
  prestigeCount: number
  permanentUpgrades: PermanentUpgradeLevels
}

function createInitialLegacy(): LegacyState {
  return {
    legacyPoints: 0,
    hasPrestiged: false,
    prestigeCount: 0,
    permanentUpgrades: createInitialPermanentUpgrades(),
  }
}

interface GameState {
  isInitialized: boolean
  tiers: VentureTier[]
  currencies: { revenue: number }
  legacy: LegacyState
  tickTier: (tierId: string) => void
  upgradeTier: (tierId: string) => void
  hireManagerForTier: (tierId: string) => void
  unlockTier: (tierId: string) => void
  resetProgress: () => void
  resetForLegacy: () => void
  purchaseLegacyUpgrade: (upgradeId: keyof typeof PERMANENT_UPGRADES) => void
}

// Wrapped in zustand's persist middleware (localStorage) per CLAUDE.md's
// "client-side persistence for v1" — transparent to the tier/economy/engine
// logic below, which is unaware it's being saved. partialize keeps only
// actual game state in localStorage; actions are recreated fresh on load.
export const useGameStore = create<GameState>()(
  persist(
    (set, get) => ({
      isInitialized: true,
      tiers: createInitialTiers(createInitialLegacy().permanentUpgrades),
      currencies: { revenue: startingRevenue(createInitialLegacy().permanentUpgrades) },
      legacy: createInitialLegacy(),

      // Advances one tier's match by exactly one tick, via the same
      // engine/economy path whether it's called from the idle interval
      // (useMatchTicker) or a manual "Push the Attack" click (VentureCard) —
      // there is no separate manual-resolution logic per tier.
      tickTier: (tierId) => {
        const { tiers, legacy } = get()
        const tierIndex = tiers.findIndex((t) => t.id === tierId)
        if (tierIndex === -1) return
        const tier = tiers[tierIndex]
        if (!tier.unlocked) return
        // Defense in depth: tiers 7-11 must never earn real Revenue before
        // a player's first prestige, even if `unlocked`/`managerHired` were
        // somehow set directly (e.g. a hand-edited localStorage save) —
        // this is the actual choke point, not just Home.tsx's render slice.
        if (!isTierRevealed(tierIndex, legacy.hasPrestiged)) return

        const { state: nextMatch } = advanceTick(soccerModule, tier.match, tier.tickIndex)
        const nextTickIndex = tier.tickIndex + 1

        // Direct per-tick Revenue: the primary generator, granted identically
        // whether this tick was triggered by a manual "Push the Attack" click
        // or the auto-play interval — same tickTier() path, no fork. This is
        // on top of (never instead of) the match-completion bonus below.
        // Both are scaled by the permanent Legacy "Revenue Boost" multiplier
        // (1 if never prestiged/purchased — no behavior change pre-prestige).
        const config = SOCCER_VENTURE_TIERS[tierIndex]
        const legacyMultiplier = globalRevenueMultiplier(legacy.permanentUpgrades)
        const perTickRevenue = Math.round(tierPerTickRevenue(config, tier.level) * legacyMultiplier)

        if (isMatchComplete(soccerModule, nextTickIndex)) {
          const { outcome, revenue: baseRevenue } = finalizeMatch(soccerModule, nextMatch)
          const completionBonus = Math.round(
            baseRevenue * config.baseRevenueMultiplier * tier.level * legacyMultiplier,
          )
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
              tiers: updatedTiers,
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
              tiers: updatedTiers,
              currencies: { revenue: s.currencies.revenue + perTickRevenue },
            }
          })
        }
      },

      // "Improve Training": spends Revenue to raise a tier's output multiplier
      // by one level. Cost grows per level (see tierUpgradeCost).
      upgradeTier: (tierId) => {
        const { tiers, currencies, legacy } = get()
        const tierIndex = tiers.findIndex((t) => t.id === tierId)
        if (tierIndex === -1) return
        const tier = tiers[tierIndex]
        if (!tier.unlocked) return
        if (!isTierRevealed(tierIndex, legacy.hasPrestiged)) return
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
        const { tiers, currencies, legacy } = get()
        const tierIndex = tiers.findIndex((t) => t.id === tierId)
        if (tierIndex === -1) return
        const tier = tiers[tierIndex]
        if (!tier.unlocked || tier.managerHired) return
        if (!isTierRevealed(tierIndex, legacy.hasPrestiged)) return
        const cost = SOCCER_VENTURE_TIERS[tierIndex].managerHireCost
        if (currencies.revenue < cost) return

        set((s) => ({
          currencies: { revenue: s.currencies.revenue - cost },
          tiers: s.tiers.map((t, i) => (i === tierIndex ? { ...t, managerHired: true } : t)),
        }))
      },

      // Unlocks a locked tier outright, spending its configured unlockCost
      // from the player's current Revenue balance — the same pool Improve
      // Training/Hire a Manager draw from. A deliberate player choice, not
      // an automatic threshold: this is what creates the invest-in-current-
      // tier vs. save-for-the-next-tier trade-off. No-op if already
      // unlocked or Revenue is insufficient.
      unlockTier: (tierId) => {
        const { tiers, currencies, legacy } = get()
        const tierIndex = tiers.findIndex((t) => t.id === tierId)
        if (tierIndex === -1) return
        const tier = tiers[tierIndex]
        if (tier.unlocked) return
        if (!isTierRevealed(tierIndex, legacy.hasPrestiged)) return
        // Permanent "Veteran Discount" Legacy upgrade shrinks every unlock
        // cost (1 if never prestiged/purchased — no behavior change
        // pre-prestige).
        const cost = Math.round(
          SOCCER_VENTURE_TIERS[tierIndex].unlockCost * unlockCostMultiplier(legacy.permanentUpgrades),
        )
        if (currencies.revenue < cost) return

        set((s) => ({
          currencies: { revenue: s.currencies.revenue - cost },
          tiers: s.tiers.map((t, i) => (i === tierIndex ? { ...t, unlocked: true } : t)),
        }))
      },

      // Wipes saved progress back to a brand-new player, INCLUDING Legacy —
      // this is the "nuke my save" debug/player button (window.confirm-
      // guarded in the UI), distinct from resetForLegacy() below which
      // deliberately keeps Legacy Points/permanent upgrades. A full reset
      // that left Legacy behind would be a confusing half-reset, so this
      // clears everything back to a true brand-new-player state.
      resetProgress: () => {
        const freshLegacy = createInitialLegacy()
        set({
          tiers: createInitialTiers(freshLegacy.permanentUpgrades),
          currencies: { revenue: startingRevenue(freshLegacy.permanentUpgrades) },
          legacy: freshLegacy,
        })
      },

      // The prestige action: converts this run's total earnings (every
      // tier's cumulativeRevenue) into Legacy Points via the same formula
      // the UI's live preview uses (calculateLegacyPoints), then wipes run
      // progress (tiers, Revenue) back to fresh-game defaults — but adds
      // the Legacy Points to the permanent legacyPoints balance and flips
      // hasPrestiged, neither of which this reset touches. No-op unless
      // FIRST_PRESTIGE_TRIGGER_TIER_ID (World Championship) is unlocked,
      // matching the trigger condition the UI gates the button on. Looked
      // up by id, not by `tiers[tiers.length - 1]` — the latter broke the
      // instant tiers 7-11 were appended to the ladder, since "the last
      // tier" became The Multiverse Cup, which is only reachable AFTER a
      // first prestige (a first prestige would have become permanently
      // impossible to trigger).
      resetForLegacy: () => {
        const { tiers } = get()
        const triggerTierUnlocked =
          tiers.find((t) => t.id === FIRST_PRESTIGE_TRIGGER_TIER_ID)?.unlocked ?? false
        if (!triggerTierUnlocked) return

        const totalEarnings = tiers.reduce((sum, t) => sum + t.cumulativeRevenue, 0)
        const gained = calculateLegacyPoints(totalEarnings)

        set((s) => {
          const nextLegacy: LegacyState = {
            ...s.legacy,
            legacyPoints: s.legacy.legacyPoints + gained,
            hasPrestiged: true,
            prestigeCount: s.legacy.prestigeCount + 1,
          }
          return {
            legacy: nextLegacy,
            tiers: createInitialTiers(nextLegacy.permanentUpgrades),
            currencies: { revenue: startingRevenue(nextLegacy.permanentUpgrades) },
          }
        })
      },

      // Spends Legacy Points on one permanent upgrade. No-op if already
      // maxed/owned or Legacy Points are insufficient — same defensive
      // shape as every other purchase action above.
      purchaseLegacyUpgrade: (upgradeId) => {
        const { legacy } = get()
        const levels = legacy.permanentUpgrades

        if (upgradeId === 'revenueBoost') {
          const nextLevel = levels.revenueBoostLevel + 1
          if (nextLevel > PERMANENT_UPGRADES.revenueBoost.maxLevel) return
          const cost = PERMANENT_UPGRADES.revenueBoost.costForLevel(nextLevel)
          if (legacy.legacyPoints < cost) return
          set((s) => ({
            legacy: {
              ...s.legacy,
              legacyPoints: s.legacy.legacyPoints - cost,
              permanentUpgrades: { ...s.legacy.permanentUpgrades, revenueBoostLevel: nextLevel },
            },
          }))
          return
        }

        if (upgradeId === 'headStartCapital') {
          if (levels.headStartCapital) return
          const cost = PERMANENT_UPGRADES.headStartCapital.cost
          if (legacy.legacyPoints < cost) return
          set((s) => ({
            legacy: {
              ...s.legacy,
              legacyPoints: s.legacy.legacyPoints - cost,
              permanentUpgrades: { ...s.legacy.permanentUpgrades, headStartCapital: true },
            },
          }))
          return
        }

        if (upgradeId === 'fastTrack') {
          if (levels.fastTrack) return
          const cost = PERMANENT_UPGRADES.fastTrack.cost
          if (legacy.legacyPoints < cost) return
          set((s) => ({
            legacy: {
              ...s.legacy,
              legacyPoints: s.legacy.legacyPoints - cost,
              permanentUpgrades: { ...s.legacy.permanentUpgrades, fastTrack: true },
            },
          }))
          return
        }

        if (upgradeId === 'veteranDiscount') {
          const nextLevel = levels.veteranDiscountLevel + 1
          if (nextLevel > PERMANENT_UPGRADES.veteranDiscount.maxLevel) return
          const cost = PERMANENT_UPGRADES.veteranDiscount.costForLevel(nextLevel)
          if (legacy.legacyPoints < cost) return
          set((s) => ({
            legacy: {
              ...s.legacy,
              legacyPoints: s.legacy.legacyPoints - cost,
              permanentUpgrades: { ...s.legacy.permanentUpgrades, veteranDiscountLevel: nextLevel },
            },
          }))
        }
      },
    }),
    {
      name: 'idle-sports-game-save',
      partialize: (state) => ({
        tiers: state.tiers,
        currencies: state.currencies,
        legacy: state.legacy,
      }),
      // Save-migration fix: zustand's default merge does a shallow spread,
      // so a persisted `tiers` array (from a save made before tiers 7-11
      // existed) would silently REPLACE the freshly-initialized 11-entry
      // array wholesale, leaving `tiers` shorter than SOCCER_VENTURE_TIERS
      // for players who already have a save. If that shorter save also has
      // hasPrestiged: true, the UI would try to render tiers whose state
      // entry is `undefined` and crash. Pad any missing trailing entries
      // with fresh tier state (unlocked: false, matching a never-yet-seen
      // tier) instead of trusting the persisted length. Harmless/no-op for
      // saves that already have a full-length `tiers` array.
      merge: (persistedState, currentState) => {
        const merged = { ...currentState, ...(persistedState as Partial<GameState>) }
        if (merged.tiers.length < SOCCER_VENTURE_TIERS.length) {
          const freshTiers = createInitialTiers(merged.legacy.permanentUpgrades)
          merged.tiers = [...merged.tiers, ...freshTiers.slice(merged.tiers.length)]
        }
        return merged
      },
    },
  ),
)
