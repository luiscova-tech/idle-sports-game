import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { StorageValue, PersistStorage } from 'zustand/middleware'
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
import { checkNewlyEarnedAchievements, assertNeverRewardType } from '../engine/achievements'
import {
  createSoccerModule,
  type SoccerMatchState,
  SOCCER_VENTURE_TIERS,
  tierUpgradeCost,
  tierPerTickRevenue,
  trainingEffectMultiplier,
  opponentLevelRangeForTier,
  TRAINING_MILESTONE_LEVELS,
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
  /** True forever once the player has prestiged at least once. Never
   *  reverts on a `resetForLegacy()` reset, only on a full `resetProgress()`
   *  wipe. Still used to gate the Legacy panel's reset-vs-locked UI; the
   *  actual per-tier reveal boundary is driven by `prestigeCount` below
   *  (see `revealedTierCount`/`isTierRevealed` in `soccerModule.ts`), since
   *  tiers 7-11 now reveal one at a time across successive prestiges rather
   *  than all at once on this flag flipping true. */
  hasPrestiged: boolean
  /** How many times the player has prestiged, ever. Never reset by
   *  `resetForLegacy()` (only by `resetProgress()`'s full wipe). Drives how
   *  many of tiers 7-11 are revealed — see `revealedTierCount` in
   *  `soccerModule.ts`. */
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

/** Stats tracked for the lifetime of a save, feeding the achievement
 *  framework — never reset by resetForLegacy() (achievements are lifetime
 *  accomplishments, not per-run stats, same persistence semantics as
 *  `legacy` above), only by the full resetProgress() wipe. A future
 *  achievement line (total Revenue earned, matches played, ...) adds a
 *  sibling field here plus its own increment site, alongside its config
 *  entries in `src/engine/achievements.ts`. */
export interface LifetimeStats {
  totalWins: number
}

function createInitialLifetimeStats(): LifetimeStats {
  return { totalWins: 0 }
}

/** Which achievement ids (from `src/engine/achievements.ts`'s ACHIEVEMENTS)
 *  have been earned — flat across every achievement line, since ids are
 *  globally unique. Same lifetime persistence as LifetimeStats above. */
export interface AchievementsState {
  earnedIds: string[]
}

function createInitialAchievements(): AchievementsState {
  return { earnedIds: [] }
}

/** Checks and grants any achievements that newly qualify given the current
 *  value of every tracked lifetime stat, applying rewards atomically.
 *  Deliberately called from BOTH of tickTier()'s branches below (not just
 *  match-completion) — a future achievement line tracking a stat that
 *  changes on every tick (e.g. total Revenue earned) needs this check to
 *  run on every tick too, or it would sit unrecognized until the next
 *  match happens to complete. `baseRevenue`/`baseLegacyPoints` are the
 *  caller's already-computed values for this tick (e.g. after adding this
 *  tick's own Revenue) — achievement rewards stack on top of those, never
 *  replace them. A no-op (same `earnedIds`, unchanged totals) whenever
 *  nothing newly qualifies, which is the overwhelmingly common case on any
 *  given tick. */
function applyEarnedAchievements(
  stats: Record<string, number>,
  earnedIds: readonly string[],
  baseRevenue: number,
  baseLegacyPoints: number,
): { earnedIds: string[]; revenue: number; legacyPoints: number; grantedCount: number } {
  const newlyEarned = checkNewlyEarnedAchievements(stats, earnedIds)
  let revenue = baseRevenue
  let legacyPoints = baseLegacyPoints
  for (const achievement of newlyEarned) {
    switch (achievement.reward.type) {
      case 'revenue':
        revenue += achievement.reward.amount
        break
      case 'legacyPoints':
        legacyPoints += achievement.reward.amount
        break
      default:
        assertNeverRewardType(achievement.reward.type)
    }
  }
  return {
    earnedIds: newlyEarned.length ? [...earnedIds, ...newlyEarned.map((a) => a.id)] : [...earnedIds],
    revenue,
    legacyPoints,
    grantedCount: newlyEarned.length,
  }
}

/** A transient "training milestone crossed" toast (see Home.tsx's
 *  NotificationToasts). Deliberately NOT persisted (absent from
 *  partialize below) — these are momentary UI events, not save state; a
 *  page reload should never resurrect a toast from a prior session. */
export interface MilestoneNotification {
  id: number
  message: string
}

interface GameState {
  isInitialized: boolean
  /** In-band mirror of the persist middleware's own `version` option below
   *  (see CURRENT_SCHEMA_VERSION) — kept as a plain field on the state
   *  itself, not just invisible middleware metadata, so anyone inspecting
   *  a save's `state` blob directly (devtools, a hand-edit, a future
   *  session debugging a save) can see which schema it's shaped like
   *  without needing to know zustand's outer `{state, version}` envelope
   *  convention. zustand's OWN `version`/`migrate` mechanism below is what
   *  actually GATES whether migration runs — this field is for visibility
   *  only, always kept equal to it. */
  schemaVersion: number
  tiers: VentureTier[]
  currencies: { revenue: number }
  legacy: LegacyState
  lifetimeStats: LifetimeStats
  achievements: AchievementsState
  notifications: MilestoneNotification[]
  tickTier: (tierId: string) => void
  upgradeTier: (tierId: string) => void
  hireManagerForTier: (tierId: string) => void
  unlockTier: (tierId: string) => void
  resetProgress: () => void
  resetForLegacy: () => void
  purchaseLegacyUpgrade: (upgradeId: keyof typeof PERMANENT_UPGRADES) => void
  dismissNotification: (id: number) => void
}

/**
 * Schema-versioning convention — a standing rule, not a one-off fix (see
 * CLAUDE.md "Schema versioning" for the full writeup). This project has hit
 * three separate save-compatibility bugs across past sessions (a persisted
 * `tiers` array silently truncating the fresh one on load, a hidden-tier
 * reveal exploit via hand-edited `unlocked`/`managerHired` flags, and
 * mid-match outcomes silently re-rolling under an old match schema) — each
 * patched ad hoc, after the fact, because no past shape change was ever
 * versioned in the first place. Going forward:
 *
 *   Any change to what `partialize` persists — including a shape change
 *   nested inside something it already persists, like `VentureTier` or
 *   `SoccerMatchState` — MUST bump CURRENT_SCHEMA_VERSION by exactly 1 and
 *   add a new entry to SCHEMA_MIGRATIONS transforming the PREVIOUS
 *   version's shape into the new one. Do not just change a shape in place
 *   and hope existing saves happen to tolerate it.
 *
 * Not every compatibility gap needs a migration, though — some are more
 * correctly fixed as tolerant/defensive READS at the point of use than as
 * a data transformation. `soccerModule.ts`'s `tick()` gates its one-time
 * outcome resolution on `tickIndex === 0`, not just `resolvedOutcome ===
 * undefined`, specifically so a match that was already mid-flight under an
 * OLD schema (missing `resolvedOutcome`/`opponentLevel` entirely) simply
 * never resolves via the new model for the rest of ITS OWN lifetime,
 * falling back to its pre-existing behavior — there is no sensible
 * "backfilled" value migration could write for an in-progress match's
 * resolved outcome, so tolerant reads are the right fix there, not a
 * migration step here.
 */
const CURRENT_SCHEMA_VERSION = 1

/**
 * SCHEMA_MIGRATIONS[v] transforms a persisted state KNOWN to be shaped like
 * version `v` into version `v + 1`'s shape. Applied in a loop (see
 * migrateGameState below) from whatever version a save reports up to
 * CURRENT_SCHEMA_VERSION — never assume migrate() is only ever called
 * exactly one version behind; a save several versions old must walk
 * through every intermediate step in order.
 */
const SCHEMA_MIGRATIONS: Record<number, (state: any) => any> = {
  // Version 0 is every save this project had before this amendment
  // introduced versioning at all — there was no schemaVersion field, ever,
  // until now, so this is treated as a single baseline rather than trying
  // to distinguish "pre-tiers-7-11" from "pre-mid-match-fix" saves (there's
  // no data left to tell those eras apart). The one gap that genuinely
  // needs a DATA transformation (not just a tolerant read) is a `tiers`
  // array shorter than the current ladder — previously patched ad hoc
  // inside `merge()` (see the ninth amendment in CLAUDE.md); moved here
  // since "pad an old array to the current shape" is exactly what a
  // migration step is for.
  0: (state: any) => {
    if (Array.isArray(state?.tiers) && state.tiers.length < SOCCER_VENTURE_TIERS.length) {
      const permanentUpgrades = state?.legacy?.permanentUpgrades ?? createInitialPermanentUpgrades()
      const freshTiers = createInitialTiers(permanentUpgrades)
      state = { ...state, tiers: [...state.tiers, ...freshTiers.slice(state.tiers.length)] }
    }
    return state
  },
}

function migrateGameState(persistedState: unknown, version: number): unknown {
  let state = persistedState
  for (let v = version; v < CURRENT_SCHEMA_VERSION; v++) {
    const step = SCHEMA_MIGRATIONS[v]
    if (step) state = step(state)
  }
  return { ...(state as object), schemaVersion: CURRENT_SCHEMA_VERSION }
}

/**
 * Every real save this project has ever produced predates this amendment's
 * versioning convention entirely, so its persisted blob has NO `version`
 * field at all. zustand's own version-mismatch check only fires when the
 * stored value has a NUMERIC version that differs from the configured one
 * (`typeof storedVersion === 'number' && storedVersion !== options.version`
 * — see zustand's persist middleware source) — a completely absent version
 * fails that `typeof` check and skips `migrate()` entirely, silently using
 * the old shape as-is. This wrapper backfills `version: 0` on read for
 * exactly that case, so zustand's own mismatch check sees `0 !==
 * CURRENT_SCHEMA_VERSION` and correctly invokes `migrateGameState`.
 * Verified directly against a real short-tiers-array save (see CLAUDE.md):
 * without this wrapper, migrate() is never called at all for a version-less
 * save, no matter what CURRENT_SCHEMA_VERSION/migrate are set to.
 */
function createVersionBackfillingStorage(): PersistStorage<unknown> | undefined {
  const base = createJSONStorage<unknown>(() => localStorage)
  if (!base) return undefined
  const backfill = (value: StorageValue<unknown> | null) => {
    if (value && typeof value.version !== 'number') {
      return { ...value, version: 0 }
    }
    return value
  }
  return {
    ...base,
    getItem: (name) => {
      const result = base.getItem(name)
      return result instanceof Promise ? result.then(backfill) : backfill(result)
    },
  }
}

// Wrapped in zustand's persist middleware (localStorage) per CLAUDE.md's
// "client-side persistence for v1" — transparent to the tier/economy/engine
// logic below, which is unaware it's being saved. partialize keeps only
// actual game state in localStorage; actions are recreated fresh on load.
export const useGameStore = create<GameState>()(
  persist(
    (set, get) => ({
      isInitialized: true,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      tiers: createInitialTiers(createInitialLegacy().permanentUpgrades),
      currencies: { revenue: startingRevenue(createInitialLegacy().permanentUpgrades) },
      legacy: createInitialLegacy(),
      lifetimeStats: createInitialLifetimeStats(),
      achievements: createInitialAchievements(),
      notifications: [],

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
        // Defense in depth: a not-yet-revealed tier must never earn real
        // Revenue, even if `unlocked`/`managerHired` were somehow set
        // directly (e.g. a hand-edited localStorage save) — this is the
        // actual choke point, not just Home.tsx's render slice.
        if (!isTierRevealed(tierIndex, legacy.prestigeCount)) return

        // Threaded into advanceTick below so the sport module can resolve
        // this match's outcome from a level-gap-driven win probability (see
        // MatchContext in engine/types.ts and resolveMatchOutcome in
        // soccerModule.ts) — only consumed on a match's first tick; every
        // later tick this match sees ignores it (the outcome's already
        // decided and stored in the match state by then).
        const matchContext = { level: tier.level, opponentLevelRange: opponentLevelRangeForTier(tierIndex) }
        const { state: nextMatch } = advanceTick(soccerModule, tier.match, tier.tickIndex, matchContext)
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
          const { outcome, revenue: baseRevenue } = finalizeMatch(soccerModule, nextMatch, matchContext)
          const completionBonus = Math.round(
            baseRevenue * config.baseRevenueMultiplier * trainingEffectMultiplier(tier.level) * legacyMultiplier,
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

            // Lifetime win count (across every tier combined) feeds the
            // achievement framework — see LifetimeStats above. Checked and
            // granted atomically in this same set() (via the shared
            // applyEarnedAchievements() helper, also called from the
            // non-completion branch below) so the UI never renders a frame
            // where the reward landed but the badge hasn't, or vice versa.
            const totalWins = s.lifetimeStats.totalWins + (outcome === 'win' ? 1 : 0)
            const granted = applyEarnedAchievements(
              { totalWins },
              s.achievements.earnedIds,
              s.currencies.revenue + totalEarned,
              s.legacy.legacyPoints,
            )

            return {
              tiers: updatedTiers,
              currencies: { revenue: granted.revenue },
              lifetimeStats: { ...s.lifetimeStats, totalWins },
              achievements: granted.grantedCount ? { earnedIds: granted.earnedIds } : s.achievements,
              legacy: granted.grantedCount ? { ...s.legacy, legacyPoints: granted.legacyPoints } : s.legacy,
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

            // No tracked stat currently changes on a non-completion tick
            // (totalWins only changes at match completion, above), so this
            // check is a no-op today — but it runs symmetrically with the
            // completion branch on purpose, so a FUTURE achievement line
            // tracking a stat that changes every tick (e.g. total Revenue
            // earned) gets caught the moment it crosses a threshold, not
            // just whenever a match next happens to complete.
            const granted = applyEarnedAchievements(
              { totalWins: s.lifetimeStats.totalWins },
              s.achievements.earnedIds,
              s.currencies.revenue + perTickRevenue,
              s.legacy.legacyPoints,
            )

            return {
              tiers: updatedTiers,
              currencies: { revenue: granted.revenue },
              achievements: granted.grantedCount ? { earnedIds: granted.earnedIds } : s.achievements,
              legacy: granted.grantedCount ? { ...s.legacy, legacyPoints: granted.legacyPoints } : s.legacy,
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
        if (!isTierRevealed(tierIndex, legacy.prestigeCount)) return
        const cost = tierUpgradeCost(SOCCER_VENTURE_TIERS[tierIndex], tier.level)
        if (currencies.revenue < cost) return

        const nextLevel = tier.level + 1
        // A single Improve Training purchase only ever raises level by
        // exactly 1, so at most one milestone can be crossed per call in
        // practice — filtering (rather than a single `includes` check)
        // still handles a future multi-level jump correctly if one is ever
        // introduced, without needing to revisit this code.
        const crossedMilestones = TRAINING_MILESTONE_LEVELS.filter(
          (milestone) => milestone > tier.level && milestone <= nextLevel,
        )

        set((s) => {
          if (crossedMilestones.length === 0) {
            return {
              currencies: { revenue: s.currencies.revenue - cost },
              tiers: s.tiers.map((t, i) => (i === tierIndex ? { ...t, level: nextLevel } : t)),
            }
          }
          let nextId = s.notifications.length ? Math.max(...s.notifications.map((n) => n.id)) + 1 : 1
          const newNotifications = crossedMilestones.map(() => ({
            id: nextId++,
            message: `${SOCCER_VENTURE_TIERS[tierIndex].name} Revenue 2x!`,
          }))
          return {
            currencies: { revenue: s.currencies.revenue - cost },
            tiers: s.tiers.map((t, i) => (i === tierIndex ? { ...t, level: nextLevel } : t)),
            notifications: [...s.notifications, ...newNotifications],
          }
        })
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
        if (!isTierRevealed(tierIndex, legacy.prestigeCount)) return
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
        if (!isTierRevealed(tierIndex, legacy.prestigeCount)) return
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
          lifetimeStats: createInitialLifetimeStats(),
          achievements: createInitialAchievements(),
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
      // owned (one-time toggles) or Legacy Points are insufficient — same
      // defensive shape as every other purchase action above. Revenue
      // Boost/Veteran Discount are uncapped (see prestige.ts): there is no
      // maxLevel to check at all, only affordability — the cost formula
      // itself (and, for Veteran Discount, its asymptotic discount curve)
      // is what keeps indefinite leveling sensible.
      purchaseLegacyUpgrade: (upgradeId) => {
        const { legacy } = get()
        const levels = legacy.permanentUpgrades

        if (upgradeId === 'revenueBoost') {
          const nextLevel = levels.revenueBoostLevel + 1
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

      // Removes one toast by id once its on-screen timer expires (see
      // NotificationToasts.tsx). No-op if it's already gone — harmless if
      // called twice for the same id (e.g. an unmount race).
      dismissNotification: (id) => {
        set((s) => ({ notifications: s.notifications.filter((n) => n.id !== id) }))
      },
    }),
    {
      name: 'idle-sports-game-save',
      storage: createVersionBackfillingStorage(),
      version: CURRENT_SCHEMA_VERSION,
      migrate: migrateGameState,
      partialize: (state) => ({
        schemaVersion: state.schemaVersion,
        tiers: state.tiers,
        currencies: state.currencies,
        legacy: state.legacy,
        lifetimeStats: state.lifetimeStats,
        achievements: state.achievements,
      }),
      // The `tiers`-array-length shape fix that used to live here moved
      // into SCHEMA_MIGRATIONS[0] above — a genuine data transformation by
      // version, not a per-load merge concern. What's left here is a
      // standing rule that isn't version-dependent at all: `notifications`
      // is deliberately excluded from partialize (see MilestoneNotification's
      // doc comment: toasts must never survive a reload) — but the blind
      // `{...currentState, ...persistedState}` spread would still copy one
      // in if a hand-edited localStorage blob has a `notifications` key at
      // all (this app never writes one there itself, but nothing stops a
      // player's own edit from adding one back). An unguarded non-array
      // value there (e.g. `null`) would crash NotificationToasts.tsx's
      // unconditional `.length` check on the very next render; a stale
      // array would resurrect old toasts, and any entry with a non-numeric
      // `id` permanently poisons the `Math.max(...)+1` id generator in
      // upgradeTier() for the rest of the session. Always keep the fresh,
      // empty array from currentState instead — never trust a persisted
      // value for this field, no matter its shape, no matter the version.
      //
      // `tiers` gets the same never-trust-the-shape treatment, for a
      // different reason: before this session, a non-array `tiers` (e.g. a
      // hand-edited `tiers: null`) crashed SYNCHRONOUSLY inside the old,
      // unguarded `merge()`'s own `merged.tiers.length` check — but that
      // throw happened inside zustand's persist internals, which swallow it
      // in a trailing `.catch()` before `set()` is ever reached, so the live
      // store silently kept its fresh in-memory defaults (data loss, but no
      // crash). Moving the length-padding logic into SCHEMA_MIGRATIONS[0]
      // added an `Array.isArray` guard that returns the corrupted value
      // unchanged instead of throwing — and, for a save that already
      // reports the current schema version, migrate() is skipped by zustand
      // entirely, so a corrupted `tiers` never even reaches that guard.
      // Either way, the corrupted value now sails cleanly through merge()
      // into `set()`, and the very next render (`useMatchTicker`'s
      // `s.tiers.filter(...)`, called unconditionally before any route) hard
      // -crashes the whole app with no error boundary — worse than before,
      // since it also blocks the only no-devtools recovery path (the
      // Settings page's DEV wipe button). Restoring the original
      // silently-keep-defaults behavior explicitly here, rather than
      // depending on an accidental throw deep in a promise chain to keep
      // providing it.
      merge: (persistedState, currentState) => {
        const merged = { ...currentState, ...(persistedState as Partial<GameState>) }
        merged.notifications = currentState.notifications
        if (!Array.isArray(merged.tiers) || merged.tiers.length !== SOCCER_VENTURE_TIERS.length) {
          merged.tiers = currentState.tiers
        }
        return merged
      },
    },
  ),
)
