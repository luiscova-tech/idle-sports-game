import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { StorageValue, PersistStorage } from 'zustand/middleware'
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
import { checkNewlyEarnedAchievements, assertNeverRewardType, ACHIEVEMENTS } from '../engine/achievements'
import {
  type VentureTierState,
  tierUpgradeCost,
  opponentLevelRangeForTier,
  TRAINING_MILESTONE_LEVELS,
  resolveVentureTierTick,
  tierIncomeRatePerSecond,
  incomeRateAnchorMultiplier,
} from '../engine/ventureTiers'
import { matchOutcomeProbabilities, matchOutcomeProbabilitiesWithoutDrawTriple } from '../engine/winProbability'
import {
  createSoccerModule,
  type SoccerMatchState,
  SOCCER_VENTURE_TIERS,
  isTierRevealed,
  allVisibleTiersUnlocked,
} from '../sports/soccer/soccerModule'
import {
  createBaseballModule,
  type BaseballMatchState,
  BASEBALL_VENTURE_TIERS,
  BASEBALL_COST_ANCHOR_SECONDS,
  scaledBaseballTiers,
  inningsForBaseballTier,
  estimatedTicksForBaseballTier,
} from '../sports/baseball/baseballModule'

// Single module-scoped instance of each currently plugged-in sport. Every
// venture tier for a given sport runs its own independent match through
// that ONE shared instance — only the payout multiplier differs per tier,
// never the sim itself. Baseball is the second sport (Build Order step 3 —
// see CLAUDE.md's "Baseball" amendment); a third would follow the exact
// same shape.
const soccerModule = createSoccerModule()
const baseballModule = createBaseballModule()

/** The state every venture tier tracks, generic over that sport's own
 *  opaque match-state shape — see VentureTierState in engine/ventureTiers.ts
 *  for why this shape has nothing sport-specific about it. */
export type VentureTier = VentureTierState<SoccerMatchState>
export type BaseballVentureTier = VentureTierState<BaseballMatchState>

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

/** Baseball tiers are deliberately independent of the Legacy/prestige
 *  system (see CLAUDE.md's "Baseball" amendment) — no permanent-upgrade
 *  pre-unlock concept applies here, unlike soccer's Fast Track. Every
 *  baseball tier, including the first (Tee Time), starts LOCKED: entering
 *  a second sport at all is its own deliberate milestone purchase, not a
 *  freebie the way soccer's own first tier is. */
function createInitialBaseballTiers(): BaseballVentureTier[] {
  return BASEBALL_VENTURE_TIERS.map((config) => ({
    id: config.id,
    unlocked: false,
    level: 1,
    managerHired: false,
    tickIndex: 0,
    match: baseballModule.createInitialState(),
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
 *  entries in `src/engine/achievements.ts`.
 *
 *  `soccerWins`/`baseballWins` (added alongside the "Soccer Wins"/"Baseball
 *  Wins" achievement lines) are per-sport breakdowns of the exact same wins
 *  `totalWins` already counts — `totalWins` itself is untouched by their
 *  addition, still incremented on every winning tick of either sport,
 *  exactly as it always has been (see tickTier/tickBaseballTier below: both
 *  branches now increment ALL THREE counters from the same single win
 *  event, never two separate increments that could drift apart). */
export interface LifetimeStats {
  totalWins: number
  soccerWins: number
  baseballWins: number
}

function createInitialLifetimeStats(): LifetimeStats {
  return { totalWins: 0, soccerWins: 0, baseballWins: 0 }
}

/**
 * Sanitizes a `lifetimeStats` value of UNKNOWN shape (persisted JSON,
 * possibly hand-edited or corrupted) into a valid LifetimeStats, backfilling
 * any missing/non-finite numeric field to 0. Shared by SCHEMA_MIGRATIONS[2]
 * (the version-gated migration path, run only when a save's persisted
 * version differs from CURRENT_SCHEMA_VERSION) AND merge()'s own guard
 * below (which runs on EVERY load, version match or not) — an adversarial
 * review caught that these needed to be the same function, not two
 * independently-written ones: a save already reporting the CURRENT schema
 * version skips migrate() entirely (zustand only invokes it on a version
 * mismatch), so a corrupted-but-current-version `lifetimeStats` — e.g. a
 * hand-edited `null`, or an object missing `soccerWins`/`baseballWins` —
 * would sail straight through the old unguarded `merge()` and either crash
 * AchievementsPanel.tsx's unconditional `s.lifetimeStats.totalWins` read on
 * the very next render (a `null` case), or silently poison
 * `soccerWins`/`baseballWins` to `NaN` forever the next time `tickTier`/
 * `tickBaseballTier` computed `s.lifetimeStats.soccerWins + 1` against an
 * `undefined` field (a missing-subfield case) — permanently blocking that
 * save's soccer-wins/baseball-wins achievement tiers with no visible error.
 * Uses `Number.isFinite`, not `typeof x === 'number'`, specifically because
 * `typeof NaN === 'number'` is true — a check that only looked at `typeof`
 * would accept an already-poisoned NaN as "valid" instead of repairing it.
 */
function sanitizeLifetimeStats(value: unknown): LifetimeStats {
  const candidate = value && typeof value === 'object' ? (value as Partial<LifetimeStats>) : {}
  return {
    totalWins: Number.isFinite(candidate.totalWins) ? (candidate.totalWins as number) : 0,
    soccerWins: Number.isFinite(candidate.soccerWins) ? (candidate.soccerWins as number) : 0,
    baseballWins: Number.isFinite(candidate.baseballWins) ? (candidate.baseballWins as number) : 0,
  }
}

/**
 * Sanitizes a `baseballCostAnchorMultiplier` value of UNKNOWN shape into a
 * valid multiplier — same `Number.isFinite`-over-`typeof` defensive pattern
 * as `sanitizeLifetimeStats` above, for the identical reason: a save
 * already AT the current schema version skips `migrate()` entirely (zustand
 * only invokes it on a version MISMATCH), so a corrupted-but-current-version
 * value (a hand-edited `null`/`NaN`/negative number) would otherwise sail
 * straight through `merge()`'s blind spread and permanently poison every
 * future baseball cost computed from it — this is the ONLY guard standing
 * between a corrupted persisted value and that outcome, called from BOTH
 * `merge()` (the always-runs path) and available for a migration step to
 * reuse rather than re-deriving the same validity check. `< 1` is also
 * rejected (not just non-finite) — `incomeRateAnchorMultiplier` never
 * produces a value below its own `1` floor, so anything less than `1` here
 * can only be corruption, never a legitimately-computed value.
 */
function sanitizeBaseballCostAnchorMultiplier(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? value : 1
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

/**
 * The player's CURRENT aggregate income rate (expected Revenue/second),
 * summed across every currently unlocked+managed tier in BOTH sports at
 * their live levels, with the live Legacy `globalRevenueMultiplier` applied
 * — feeds the 'scaledRevenue' achievement reward variant (see
 * engine/achievements.ts's AchievementReward and CLAUDE.md's income-rate-
 * scaled-rewards amendment), AND (new, see CLAUDE.md's "income-rate-
 * anchored entry costs" convention) is reused UNCHANGED as the exact same
 * income-rate snapshot a sport's entry-point costs get re-anchored to —
 * per that convention's own "do not write a second parallel calculation"
 * rule. Reuses `tierIncomeRatePerSecond` (engine/ventureTiers.ts) per-tier
 * — this function is just the "sum across every tier of both sports"
 * orchestration, which is inherently a store-level concern (same reasoning
 * as `LegacyPanel.tsx`'s/`FranchiseTab.tsx`'s own combined-across-both-
 * sports totals): the sport-agnostic engine layer has no way to iterate
 * "every sport," only one sport's own tier list at a time.
 *
 * Takes plain `{unlocked, managerHired, level}[]` arrays rather than the
 * store's own `VentureTier[]`/`BaseballVentureTier[]` types, so this stays
 * usable from anywhere without a circular-import concern. `baseballAnchorMultiplier`
 * is likewise a plain number (not read from a closed-over store reference),
 * so a migration step computing a HYPOTHETICAL rate against an OLD,
 * pre-migration state (which may have no `baseballCostAnchorMultiplier`
 * field at all yet) can pass `1` explicitly rather than needing a live
 * store instance to read from.
 *
 * Deliberately NOT memoized or cached anywhere — every call recomputes from
 * whatever tier/legacy state is passed in, which is what lets the caller
 * satisfy "computed fresh at the moment of completion, not precomputed
 * ahead of time": each of tickTier's/tickBaseballTier's `set()` calls below
 * passes a closure over `s` (the state as of that exact `set()`), so a
 * reward granted mid-set reflects the economy at that literal instant, not
 * a stale snapshot from an earlier tick or render.
 */
function currentAggregateIncomeRatePerSecond(
  tiers: { unlocked: boolean; managerHired: boolean; level: number }[],
  baseballTiers: { unlocked: boolean; managerHired: boolean; level: number }[],
  legacyMultiplier: number,
  baseballAnchorMultiplier: number,
): number {
  let total = 0
  for (let i = 0; i < tiers.length; i++) {
    total += tierIncomeRatePerSecond(
      tiers[i],
      i,
      SOCCER_VENTURE_TIERS[i],
      legacyMultiplier,
      matchOutcomeProbabilities,
      soccerModule.ticksPerMatch,
    )
  }
  const liveBaseballTiers = scaledBaseballTiers(baseballAnchorMultiplier)
  for (let i = 0; i < baseballTiers.length; i++) {
    total += tierIncomeRatePerSecond(
      baseballTiers[i],
      i,
      liveBaseballTiers[i],
      legacyMultiplier,
      matchOutcomeProbabilitiesWithoutDrawTriple,
      estimatedTicksForBaseballTier(i),
    )
  }
  return total
}

/**
 * Derives baseball's per-save `baseballCostAnchorMultiplier` from a given
 * economic state — the ONE authoritative implementation of "anchor baseball's
 * entry costs to this much of the player's income rate," used by BOTH places
 * that ever need to establish it: `SCHEMA_MIGRATIONS[5]` (the original v5->v6
 * introduction of the convention) and `resetForLegacy()` (which re-anchors
 * against the POST-reset economy — see that action's own comment). Extracted
 * from the migration rather than reimplemented alongside it, per this
 * project's repeated "two copies of the same economy math silently drift
 * apart" bug history and the anchor convention's own founding rule.
 *
 * `soccerTiers`/`baseballTiers` are whatever tier state the anchor should be
 * measured against — the CALLER decides which economy is the right basis
 * (the migration passes soccer-only, since it's about to destroy baseball's
 * income; resetForLegacy passes the post-reset arrays for both sports, since
 * it destroys both). This function never assumes; it just measures what it's
 * handed.
 *
 * Wrapped in a try/catch that falls back to the floor (`1` = baseball's
 * unscaled reference numbers), because `tierIncomeRatePerSecond` dereferences
 * `tier.unlocked` and THROWS on a null/primitive element — possible on a
 * hand-edited/corrupted save whose array is the right LENGTH but has a
 * malformed element. Inside a migration an uncaught throw is swallowed by
 * zustand's persist hydrate and discards the ENTIRE migration (total loss of
 * soccer/Revenue/Legacy); inside a store action it would abort the prestige
 * mid-way. Falling back to the floor keeps both paths completing safely.
 */
function computeBaseballCostAnchorMultiplier(
  soccerTiers: { unlocked: boolean; managerHired: boolean; level: number }[],
  baseballTiers: { unlocked: boolean; managerHired: boolean; level: number }[],
  permanentUpgrades: PermanentUpgradeLevels,
): number {
  try {
    const incomeRate = currentAggregateIncomeRatePerSecond(
      soccerTiers,
      baseballTiers,
      globalRevenueMultiplier(permanentUpgrades),
      1,
    )
    return incomeRateAnchorMultiplier(
      incomeRate,
      BASEBALL_COST_ANCHOR_SECONDS,
      BASEBALL_VENTURE_TIERS[0].unlockCost,
    )
  } catch {
    return 1
  }
}

/**
 * The total earnings being GIVEN UP by a prestige — every soccer tier's plus
 * every baseball tier's `cumulativeRevenue`. The single input to
 * `calculateLegacyPoints` (engine/prestige.ts), shared by `resetForLegacy()`
 * and `LegacyPanel.tsx`'s live preview so the number a player is shown can
 * never drift from the number they actually receive (this project's standing
 * drift-proof-preview pattern).
 *
 * Deliberately phrased as "being given up by this reset" rather than "this
 * run's": for soccer it is always exactly this run (every prestige has
 * always zeroed soccer's ledger), but on ONE transitional prestige per save
 * baseball's half can span several soccer runs — see the "one-time baseball
 * catch-up" note in CLAUDE.md for why that is accepted rather than migrated
 * away. After that first post-change prestige the two halves are permanently
 * in step, since both ledgers now reset together.
 *
 * Baseball is included because `resetForLegacy()` now SACRIFICES baseball's
 * progress too (it used to reset only soccer) — the Legacy Points reward
 * should reflect the full franchise's earnings being given up, not just one
 * sport's. Achievement-granted Revenue is deliberately NOT part of this: it
 * never enters any tier's `cumulativeRevenue`, matching that field's own
 * long-standing documented per-tier scope.
 */
export function totalFranchiseEarnings(
  soccerTiers: { cumulativeRevenue: number }[],
  baseballTiers: { cumulativeRevenue: number }[],
): number {
  const sum = (acc: number, t: { cumulativeRevenue: number }) =>
    acc + (Number.isFinite(t?.cumulativeRevenue) ? t.cumulativeRevenue : 0)
  return soccerTiers.reduce(sum, 0) + baseballTiers.reduce(sum, 0)
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
 *  given tick.
 *
 *  `getIncomeRatePerSecond` is a LAZY thunk, not a pre-computed number —
 *  `currentAggregateIncomeRatePerSecond` above loops over every tier of
 *  both sports doing real probability math, and the overwhelming majority
 *  of ticks earn nothing new at all; computing it unconditionally on every
 *  single tick (this function already runs on every tick, completion or
 *  not, per the doc comment above) would be pure waste. Only the
 *  'scaledRevenue' branch below ever actually calls it, so the cost is paid
 *  only on the rare tick that actually grants one. */
function applyEarnedAchievements(
  stats: Record<string, number>,
  earnedIds: readonly string[],
  baseRevenue: number,
  baseLegacyPoints: number,
  getIncomeRatePerSecond: () => number,
): { earnedIds: string[]; revenue: number; legacyPoints: number; grantedCount: number } {
  const newlyEarned = checkNewlyEarnedAchievements(stats, earnedIds)
  let revenue = baseRevenue
  let legacyPoints = baseLegacyPoints
  for (const achievement of newlyEarned) {
    // An if/else chain, not a `switch` — see assertNeverRewardType's own
    // doc comment (engine/achievements.ts) for why: a verified quirk in
    // this project's exact TypeScript/tsconfig combination fails to narrow
    // a 3+-variant discriminated union's discriminant to `never` in a
    // switch's `default` branch, even though the identical union narrows
    // correctly through an if/else chain.
    const { reward } = achievement
    if (reward.type === 'revenue') {
      revenue += reward.amount
    } else if (reward.type === 'legacyPoints') {
      legacyPoints += reward.amount
    } else if (reward.type === 'scaledRevenue') {
      // `Number.isFinite` guard, not just `Math.max` alone — an adversarial
      // review caught that `Math.max(NaN, minAmount)` evaluates to `NaN` in
      // JS, not `minAmount`, so `minAmount`'s own doc comment promise ("a
      // floor beneath which this reward can never fall") would silently
      // NOT hold against a corrupted rate (e.g. a hand-edited save with a
      // non-finite `level` on ANY tier of either sport, even one the player
      // never touches, poisoning `currentAggregateIncomeRatePerSecond`'s
      // sum for every future achievement grant, not just that one tier's
      // own future ticks). Collapsing a non-finite rate to a 0-Revenue
      // scaled amount BEFORE the `Math.max` means the floor always applies
      // cleanly instead — matching the same `Number.isFinite`-over-`typeof`
      // defensive pattern `sanitizeLifetimeStats` already established for
      // exactly this class of "never trust a persisted/computed number"
      // case.
      const rawRate = getIncomeRatePerSecond()
      const scaledAmount = Number.isFinite(rawRate) ? Math.round(reward.incomeRateSeconds * rawRate) : 0
      revenue += Math.max(scaledAmount, reward.minAmount)
    } else {
      assertNeverRewardType(reward)
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
  /** Baseball's own parallel tier list (see CLAUDE.md's "Baseball"
   *  amendment) — a SEPARATE array from soccer's `tiers`, not merged into
   *  one heterogeneous list, so each sport's own match-state shape stays
   *  concretely typed rather than needing a runtime type-discriminator on
   *  every tier. Shares the SAME global `currencies.revenue` pool as
   *  soccer (see tickBaseballTier/unlockBaseballTier below) — Revenue
   *  stays one currency across every sport, per this project's currency-
   *  separation-by-TYPE-not-by-sport principle. */
  baseballTiers: BaseballVentureTier[]
  /**
   * The per-save multiplicative rescale factor applied to
   * `BASEBALL_VENTURE_TIERS`' three COST fields ONLY (unlockCost,
   * managerHireCost, upgradeBaseCost) — see `scaledBaseballTiers` (imported
   * from baseballModule.ts) and CLAUDE.md's "income-rate-anchored entry
   * costs" convention. Deliberately NEVER applied to `baseRevenueMultiplier`
   * — see `scaledTierConfigs`' own doc comment (engine/ventureTiers.ts) for
   * the real, shipped bug this exclusion fixes: revenue must be driven
   * purely by level/training/manager-automation, with zero influence from
   * how wealthy the player happens to be. `1` (a brand-new save's default,
   * and every save's default before this convention existed) means
   * baseball's costs read exactly as `BASEBALL_VENTURE_TIERS`' own
   * hardcoded reference numbers — this field being `1` is a genuine no-op,
   * not a placeholder.
   *
   * Established ONCE PER ECONOMIC ERA, never silently recomputed on every
   * load (a moving cost target would be a worse player experience than a
   * fixed, if elevated, one). It is (re-)established at exactly three points,
   * all of which go through the ONE shared
   * `computeBaseballCostAnchorMultiplier` helper:
   *   - `SCHEMA_MIGRATIONS[5]` — an existing save migrating past the point
   *     this convention was introduced, anchored to that save's SURVIVING
   *     income rate (soccer only, since baseball's own income is reset to
   *     zero in that same step).
   *   - `resetForLegacy()` — a prestige now resets BOTH sports, so the anchor
   *     is recomputed against the POST-reset economy (in practice: no
   *     managers anywhere, so income 0 -> floors back to `1`). Without this,
   *     freshly-relocked baseball tiers would still be priced for wealth the
   *     player just gave up.
   *   - a brand-new save, which simply starts at `1` (its income rate is
   *     genuinely zero at creation — the SAME floor the helper would compute
   *     anyway, without needing to call it).
   * `resetProgress()`'s full dev wipe likewise puts this back to `1`.
   */
  baseballCostAnchorMultiplier: number
  currencies: { revenue: number }
  legacy: LegacyState
  lifetimeStats: LifetimeStats
  achievements: AchievementsState
  notifications: MilestoneNotification[]
  tickTier: (tierId: string) => void
  upgradeTier: (tierId: string) => void
  hireManagerForTier: (tierId: string) => void
  unlockTier: (tierId: string) => void
  tickBaseballTier: (tierId: string) => void
  upgradeBaseballTier: (tierId: string) => void
  hireManagerForBaseballTier: (tierId: string) => void
  unlockBaseballTier: (tierId: string) => void
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
const CURRENT_SCHEMA_VERSION = 6

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
  // Version 1 -> 2: baseball's own tier list (`baseballTiers`) is new as of
  // this version — a version-1 save has no such field at all. This is a
  // straightforward "backfill a missing array with fresh defaults" step,
  // the exact same shape as version 0's own tiers-padding migration above
  // (this project's standing schema-versioning convention exists precisely
  // so a NEW persisted field like this one gets a real migration step
  // instead of just being silently absent-then-undefined on an old save).
  1: (state: any) => {
    if (!Array.isArray(state?.baseballTiers) || state.baseballTiers.length !== BASEBALL_VENTURE_TIERS.length) {
      state = { ...state, baseballTiers: createInitialBaseballTiers() }
    }
    return state
  },
  // Version 2 -> 3: LifetimeStats gained soccerWins/baseballWins (per-sport
  // breakdowns feeding the new "Soccer Wins"/"Baseball Wins" achievement
  // lines) alongside the pre-existing totalWins. A version-2 save's
  // lifetimeStats has no such fields at all. There is no sensible backfill
  // OTHER than 0 for either — unlike the tiers-padding/baseballTiers-backfill
  // migrations above, there's no historical per-sport breakdown of past wins
  // to recover (this project never tracked which sport a win came from until
  // now), so retroactively crediting existing totalWins to either counter
  // would be fabricating data, not recovering it. totalWins itself is left
  // completely untouched — only the two new counters are backfilled, both to
  // 0, meaning an existing player's "Soccer Wins"/"Baseball Wins" progress
  // starts fresh from their very next win in each sport, same as any
  // brand-new achievement line always has to for players who already had
  // relevant history before it existed (see the "First Win" line's own
  // twelfth-amendment addition for the same shape of gap). Defensively
  // rebuilds the whole lifetimeStats object (not just the two new fields)
  // in case a corrupted/hand-edited save has a non-object or partially
  // shaped `lifetimeStats` at all — matching this file's existing
  // never-trust-persisted-shape posture for tiers/baseballTiers/notifications
  // above, just for a plain-object field instead of an array one.
  2: (state: any) => ({ ...state, lifetimeStats: sanitizeLifetimeStats(state?.lifetimeStats) }),
  // Version 3 -> 4: baseball's own tier list grew from 3 tiers (the Phase 1
  // validation slice) to 6 (Phase 2's three new real tiers — college, minor
  // league, MLB; see CLAUDE.md's "Baseball: Phase 2" amendment). A
  // version-3 save's `baseballTiers` is REAL and already has real per-tier
  // progress on tiers 0-2 — this pads it with 3 fresh locked tiers rather
  // than replacing it outright, the exact same "pad an old array to the
  // current shape, preserve everything already there" pattern
  // SCHEMA_MIGRATIONS[0] already established for soccer's own `tiers` array
  // when IT grew (6 -> 11 tiers, the ninth amendment). Deliberately NOT the
  // same shape as SCHEMA_MIGRATIONS[1] above (which fully REPLACES
  // baseballTiers) — that step only ever runs against a version 0/1 save,
  // which predates baseballTiers existing as a real feature at all (nothing
  // to preserve there); this step runs against a version-3 save, which DOES
  // have real progress to preserve.
  3: (state: any) => {
    if (Array.isArray(state?.baseballTiers) && state.baseballTiers.length < BASEBALL_VENTURE_TIERS.length) {
      const freshBaseballTiers = createInitialBaseballTiers()
      state = {
        ...state,
        baseballTiers: [...state.baseballTiers, ...freshBaseballTiers.slice(state.baseballTiers.length)],
      }
    }
    return state
  },
  // Version 4 -> 5: baseball's own tier list grew again, from 6 tiers
  // (Phase 2's completed real arc) to 11 (this session's 5 fictional tiers
  // — mudville-miracle through the-interdimensional-series; see CLAUDE.md's
  // "Baseball: fictional tiers" amendment). A version-4 save's
  // `baseballTiers` has REAL progress on its existing 6 entries — same
  // "pad, don't replace" pattern as SCHEMA_MIGRATIONS[3] (which did the
  // exact same thing for the 3->6 growth), not SCHEMA_MIGRATIONS[1]'s full
  // replacement (which only ever runs against a save that predates
  // baseballTiers existing as a feature at all).
  4: (state: any) => {
    if (Array.isArray(state?.baseballTiers) && state.baseballTiers.length < BASEBALL_VENTURE_TIERS.length) {
      const freshBaseballTiers = createInitialBaseballTiers()
      state = {
        ...state,
        baseballTiers: [...state.baseballTiers, ...freshBaseballTiers.slice(state.baseballTiers.length)],
      }
    }
    return state
  },
  // Version 5 -> 6: the "income-rate-anchored entry costs" fix (see
  // CLAUDE.md's dedicated amendment for the full writeup). Baseball's tier
  // costs were fixed absolute numbers, calibrated once against a
  // hypothetical "typical" progression pace — but Revenue is ONE pool
  // shared with soccer, so a player who'd built up substantial
  // soccer-derived wealth/income could trivially afford baseball's entire
  // ladder, defeating its intended "a real second commitment" feel
  // (confirmed directly by the actual player). This step is a DELIBERATE,
  // one-time, INTENTIONAL reset — not a bug, and not something a future
  // session should ever "fix" by trying to restore a save's old baseball
  // progress or its pre-anchor costs:
  //   1. Snapshots the income rate that SURVIVES this reset — soccer only
  //      (baseball's own income is EXCLUDED because it's about to be zeroed;
  //      see the detailed rationale at the snapshot call below) — via the
  //      exact same `currentAggregateIncomeRatePerSecond` used everywhere
  //      else in this file, never a second parallel calculation (this
  //      convention's founding rule). `tiers` is defensively treated as
  //      empty unless it's ALREADY exactly the expected length (mirroring
  //      `merge()`'s own guard below), `legacy.permanentUpgrades` falls back
  //      to fresh defaults the same way `SCHEMA_MIGRATIONS[0]` does, and the
  //      whole snapshot is try/caught — a migration step must never THROW on
  //      a corrupted save (an uncaught throw is swallowed deep in zustand's
  //      persist internals and silently discards the ENTIRE migration, far
  //      worse than a safe fallback). `1` is passed as the baseball anchor
  //      multiplier for this snapshot — moot here since baseball is passed as
  //      `[]`, but it documents that pre-v6 saves priced baseball at unscaled
  //      reference numbers regardless.
  //   2. Derives `baseballCostAnchorMultiplier` from that snapshot via
  //      `incomeRateAnchorMultiplier` — anchoring baseball's FIRST tier's
  //      unlockCost to `BASEBALL_COST_ANCHOR_SECONDS` worth of the player's own
  //      current combined income, floored at `1` (baseball's original,
  //      unscaled numbers) so a near-zero-income save is never made
  //      CHEAPER than its own carefully-simulated baseline — see that
  //      function's own doc comment for the full reasoning.
  //   3. Resets `baseballTiers` to `createInitialBaseballTiers()` —
  //      completely fresh: every tier locked, level 1, zero
  //      matches/cumulativeRevenue, no manager, matching a brand-new
  //      player's starting state exactly. Per instruction, this is a
  //      DELIBERATE wipe of baseball's own progress specifically — soccer's
  //      `tiers`, the shared `currencies.revenue` balance itself, and
  //      `legacy` are all left completely untouched by this step (the
  //      spread at the end preserves everything not explicitly overridden).
  //   4. Resets `lifetimeStats.baseballWins` to `0` (via
  //      `sanitizeLifetimeStats`, so a corrupted `lifetimeStats` gets
  //      repaired at the same time) — `totalWins`/`soccerWins` are
  //      deliberately NOT touched, per instruction. This is a KNOWN,
  //      ACCEPTED one-time break of the otherwise-usually-true invariant
  //      `totalWins === soccerWins + baseballWins`: whatever fraction of
  //      `totalWins` came from baseball wins earned before this reset stays
  //      counted in `totalWins` forever (a lifetime accomplishment, per
  //      that line's own established philosophy), while `baseballWins`
  //      itself starts over from `0` so ITS OWN achievement line can be
  //      genuinely re-earned under the corrected economy. Confirmed by grep
  //      before writing this step: nothing else in this codebase assumes
  //      that invariant holds — the three stats are always displayed and
  //      thresholded completely independently.
  //   5. Removes any baseball-specific achievement id — derived from
  //      `ACHIEVEMENTS` by `statTracked === 'baseballWins'`, not hardcoded,
  //      so a future baseball-specific achievement line is automatically
  //      covered too — from `achievements.earnedIds`. The player re-earns
  //      (and re-receives the reward for) those specific badges once
  //      `baseballWins` crosses their threshold again. Every other earned
  //      id (the combined `totalWins` line, the `soccerWins` line) is left
  //      completely untouched, per instruction. No currency already granted
  //      by a since-un-earned baseball achievement is clawed back — that
  //      reward was a one-time historical grant, not an ongoing
  //      entitlement, and clawing it back could push a save's Revenue
  //      negative depending on what's since been spent.
  5: (state: any) => {
    const safeSoccerTiers =
      Array.isArray(state?.tiers) && state.tiers.length === SOCCER_VENTURE_TIERS.length ? state.tiers : []
    const permanentUpgrades = state?.legacy?.permanentUpgrades ?? createInitialPermanentUpgrades()
    // Anchor to the income that SURVIVES this reset — soccer only (baseball's
    // `[]` here). Baseball's own current income is deliberately EXCLUDED from
    // the snapshot: this step is about to reset baseball to zero income, so
    // counting the baseball income it's about to DESTROY would inflate the
    // anchor and could WALL a baseball-heavy save's re-entry — Tee Time would
    // be priced against a transient peak (soccer + soon-gone baseball) the
    // player no longer has post-reset, instead of the income they'll actually
    // fund the re-climb with. An adversarial review flagged this. This is
    // still the SAME shared currentAggregateIncomeRatePerSecond (not a parallel
    // calc — the instruction's rule), just evaluated against post-reset
    // economic reality.
    //
    // Two defensive layers on top: (1) the soccer length guard above treats a
    // wrong-shaped `tiers` as empty (income 0 -> floor -> multiplier 1); (2)
    // the try/catch inside computeBaseballCostAnchorMultiplier — the length
    // guard ensures a right-length ARRAY but NOT that every element is a
    // well-shaped object, and tierIncomeRatePerSecond dereferences
    // `tier.unlocked`, which THROWS on a null/primitive element (a
    // hand-edited/partially-corrupted save). An uncaught throw here is
    // swallowed deep in zustand's persist hydrate and DISCARDS THE ENTIRE
    // MIGRATION (silently reverting the player to fresh defaults — total loss
    // of soccer/Revenue/Legacy), the exact failure this step's own comment
    // above promises never to cause. Falling back to the floor (multiplier 1)
    // on any throw lets the migration still complete: soccer/Revenue/Legacy
    // preserved, baseball still reset. Both caught by adversarial review.
    const baseballCostAnchorMultiplier = computeBaseballCostAnchorMultiplier(
      safeSoccerTiers,
      [],
      permanentUpgrades,
    )

    const sanitizedLifetimeStats = sanitizeLifetimeStats(state?.lifetimeStats)
    const baseballAchievementIds = new Set(
      ACHIEVEMENTS.filter((a) => a.statTracked === 'baseballWins').map((a) => a.id),
    )
    const earnedIds = Array.isArray(state?.achievements?.earnedIds) ? state.achievements.earnedIds : []

    return {
      ...state,
      baseballTiers: createInitialBaseballTiers(),
      baseballCostAnchorMultiplier,
      lifetimeStats: { ...sanitizedLifetimeStats, baseballWins: 0 },
      achievements: { earnedIds: earnedIds.filter((id: string) => !baseballAchievementIds.has(id)) },
    }
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
      baseballTiers: createInitialBaseballTiers(),
      // A brand-new save starts at the floor (1 = baseball's original,
      // unscaled reference numbers). A fresh player's income is genuinely
      // zero at creation, so this is exactly what incomeRateAnchorMultiplier
      // would compute anyway — no migration needed for a new save. See the
      // field's own doc comment on GameState and CLAUDE.md's income-rate-
      // anchored-costs convention.
      baseballCostAnchorMultiplier: 1,
      currencies: { revenue: startingRevenue(createInitialLegacy().permanentUpgrades) },
      legacy: createInitialLegacy(),
      lifetimeStats: createInitialLifetimeStats(),
      achievements: createInitialAchievements(),
      notifications: [],

      // Advances one tier's match by exactly one tick, via the same
      // engine/economy path whether it's called from the idle interval
      // (useMatchTicker) or a manual "Push the Attack" click (VentureCard) —
      // there is no separate manual-resolution logic per tier. The actual
      // per-tick/completion resolution math is the shared
      // resolveVentureTierTick (engine/ventureTiers.ts) — this action is
      // just the store-side wiring (which array, which currency bucket)
      // around it. tickBaseballTier below is the structurally-parallel
      // twin for baseball; see this project's Testing Conventions in
      // CLAUDE.md for why this specific amount of plumbing duplication
      // (not the underlying economic MATH, which is fully shared) was a
      // deliberate, documented tradeoff for this validation slice.
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

        const config = SOCCER_VENTURE_TIERS[tierIndex]
        const legacyMultiplier = globalRevenueMultiplier(legacy.permanentUpgrades)
        const matchContext = { level: tier.level, opponentLevelRange: opponentLevelRangeForTier(tierIndex) }
        const result = resolveVentureTierTick(soccerModule, tier, matchContext, config, legacyMultiplier)

        if (result.completed) {
          const totalEarned = result.perTickRevenue + (result.completionBonus ?? 0)
          set((s) => {
            const updatedTiers = s.tiers.map((t, i) =>
              i === tierIndex
                ? {
                    ...t,
                    match: result.nextMatch,
                    tickIndex: result.nextTickIndex,
                    matchesCompleted: t.matchesCompleted + 1,
                    cumulativeRevenue: t.cumulativeRevenue + totalEarned,
                    lastOutcome: result.outcome ?? t.lastOutcome,
                  }
                : t,
            )

            // Lifetime win count (across every venture tier of every sport
            // combined) feeds the achievement framework — see LifetimeStats
            // above. `soccerWins` is the same win event's per-sport
            // breakdown, incremented alongside `totalWins` from the exact
            // same `result.outcome === 'win'` check — never a second,
            // separately-derived increment that could drift out of sync
            // with the combined counter. `baseballWins` is passed through
            // UNCHANGED (this is soccer's own tick action; baseball's own
            // wins are never touched here), matching the symmetric-stats-
            // record pattern applyEarnedAchievements expects. Checked and
            // granted atomically in this same set() (via the shared
            // applyEarnedAchievements() helper, also called from the
            // non-completion branch below AND from baseball's own tick
            // action) so the UI never renders a frame where the reward
            // landed but the badge hasn't, or vice versa.
            const isWin = result.outcome === 'win'
            const totalWins = s.lifetimeStats.totalWins + (isWin ? 1 : 0)
            const soccerWins = s.lifetimeStats.soccerWins + (isWin ? 1 : 0)
            const granted = applyEarnedAchievements(
              { totalWins, soccerWins, baseballWins: s.lifetimeStats.baseballWins },
              s.achievements.earnedIds,
              s.currencies.revenue + totalEarned,
              s.legacy.legacyPoints,
              () =>
                currentAggregateIncomeRatePerSecond(
                  s.tiers,
                  s.baseballTiers,
                  globalRevenueMultiplier(s.legacy.permanentUpgrades),
                  s.baseballCostAnchorMultiplier,
                ),
            )

            return {
              tiers: updatedTiers,
              currencies: { revenue: granted.revenue },
              lifetimeStats: { ...s.lifetimeStats, totalWins, soccerWins },
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
                    match: result.nextMatch,
                    tickIndex: result.nextTickIndex,
                    cumulativeRevenue: t.cumulativeRevenue + result.perTickRevenue,
                  }
                : t,
            )

            // No tracked stat currently changes on a non-completion tick
            // (totalWins/soccerWins/baseballWins only change at match
            // completion, above), so this check is a no-op today — but it
            // runs symmetrically with the completion branch on purpose, so
            // a FUTURE achievement line tracking a stat that changes every
            // tick (e.g. total Revenue earned) gets caught the moment it
            // crosses a threshold, not just whenever a match next happens
            // to complete.
            const granted = applyEarnedAchievements(
              {
                totalWins: s.lifetimeStats.totalWins,
                soccerWins: s.lifetimeStats.soccerWins,
                baseballWins: s.lifetimeStats.baseballWins,
              },
              s.achievements.earnedIds,
              s.currencies.revenue + result.perTickRevenue,
              s.legacy.legacyPoints,
              () =>
                currentAggregateIncomeRatePerSecond(
                  s.tiers,
                  s.baseballTiers,
                  globalRevenueMultiplier(s.legacy.permanentUpgrades),
                  s.baseballCostAnchorMultiplier,
                ),
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

      // Baseball's own tick/upgrade/hire-manager/unlock actions — the
      // structurally-parallel twin of soccer's four actions above, over
      // `baseballTiers` instead of `tiers` and BASEBALL_VENTURE_TIERS
      // instead of SOCCER_VENTURE_TIERS. Deliberately NOT gated by
      // isTierRevealed/prestigeCount at all — baseball exists independently
      // of the Legacy/prestige system for this validation slice (see
      // CLAUDE.md's "Baseball" amendment): every baseball tier is either
      // locked (needs its own unlockBaseballTier purchase) or unlocked,
      // with no hidden-until-prestige reveal concept layered on top. Shares
      // the exact same global `currencies.revenue` pool, the same
      // globalRevenueMultiplier/unlockCostMultiplier Legacy multipliers
      // (Revenue Boost/Veteran Discount apply to "every tier, every run,
      // forever" — already documented as sport-agnostic, not soccer-only),
      // and feeds the exact same shared `lifetimeStats.totalWins`
      // achievement line as soccer (that line's own documented philosophy
      // is "total wins across every venture tier combined," not "every
      // soccer venture tier").
      tickBaseballTier: (tierId) => {
        const { baseballTiers, legacy, baseballCostAnchorMultiplier } = get()
        const tierIndex = baseballTiers.findIndex((t) => t.id === tierId)
        if (tierIndex === -1) return
        const tier = baseballTiers[tierIndex]
        if (!tier.unlocked) return

        // The LIVE (per-save-anchored) config — not the raw
        // BASEBALL_VENTURE_TIERS reference — for the same "one authoritative
        // source" reason every other baseball action uses it (see
        // scaledBaseballTiers' own doc comment). Note this does NOT mean
        // per-tick/completion revenue is wealth-scaled: `config.
        // baseRevenueMultiplier` is deliberately UNTOUCHED by the anchor
        // (only unlockCost/managerHireCost/upgradeBaseCost are) — see
        // scaledTierConfigs' doc comment for the real bug this exclusion
        // fixes. Revenue here is computed from the exact same reference
        // baseRevenueMultiplier every save sees, regardless of wealth.
        const config = scaledBaseballTiers(baseballCostAnchorMultiplier)[tierIndex]
        const legacyMultiplier = globalRevenueMultiplier(legacy.permanentUpgrades)
        const matchContext = {
          level: tier.level,
          opponentLevelRange: opponentLevelRangeForTier(tierIndex),
          matchLength: inningsForBaseballTier(tierIndex),
        }
        const result = resolveVentureTierTick(baseballModule, tier, matchContext, config, legacyMultiplier)

        if (result.completed) {
          const totalEarned = result.perTickRevenue + (result.completionBonus ?? 0)
          set((s) => {
            const updatedTiers = s.baseballTiers.map((t, i) =>
              i === tierIndex
                ? {
                    ...t,
                    match: result.nextMatch,
                    tickIndex: result.nextTickIndex,
                    matchesCompleted: t.matchesCompleted + 1,
                    cumulativeRevenue: t.cumulativeRevenue + totalEarned,
                    lastOutcome: result.outcome ?? t.lastOutcome,
                  }
                : t,
            )
            // Structurally the same increment shape as soccer's tickTier
            // above, just baseballWins instead of soccerWins — see that
            // action's own comment for why both counters are always derived
            // from the same single `result.outcome === 'win'` check rather
            // than two independent increments.
            const isWin = result.outcome === 'win'
            const totalWins = s.lifetimeStats.totalWins + (isWin ? 1 : 0)
            const baseballWins = s.lifetimeStats.baseballWins + (isWin ? 1 : 0)
            const granted = applyEarnedAchievements(
              { totalWins, soccerWins: s.lifetimeStats.soccerWins, baseballWins },
              s.achievements.earnedIds,
              s.currencies.revenue + totalEarned,
              s.legacy.legacyPoints,
              () =>
                currentAggregateIncomeRatePerSecond(
                  s.tiers,
                  s.baseballTiers,
                  globalRevenueMultiplier(s.legacy.permanentUpgrades),
                  s.baseballCostAnchorMultiplier,
                ),
            )
            return {
              baseballTiers: updatedTiers,
              currencies: { revenue: granted.revenue },
              lifetimeStats: { ...s.lifetimeStats, totalWins, baseballWins },
              achievements: granted.grantedCount ? { earnedIds: granted.earnedIds } : s.achievements,
              legacy: granted.grantedCount ? { ...s.legacy, legacyPoints: granted.legacyPoints } : s.legacy,
            }
          })
        } else {
          set((s) => {
            const updatedTiers = s.baseballTiers.map((t, i) =>
              i === tierIndex
                ? { ...t, match: result.nextMatch, tickIndex: result.nextTickIndex, cumulativeRevenue: t.cumulativeRevenue + result.perTickRevenue }
                : t,
            )
            const granted = applyEarnedAchievements(
              {
                totalWins: s.lifetimeStats.totalWins,
                soccerWins: s.lifetimeStats.soccerWins,
                baseballWins: s.lifetimeStats.baseballWins,
              },
              s.achievements.earnedIds,
              s.currencies.revenue + result.perTickRevenue,
              s.legacy.legacyPoints,
              () =>
                currentAggregateIncomeRatePerSecond(
                  s.tiers,
                  s.baseballTiers,
                  globalRevenueMultiplier(s.legacy.permanentUpgrades),
                  s.baseballCostAnchorMultiplier,
                ),
            )
            return {
              baseballTiers: updatedTiers,
              currencies: { revenue: granted.revenue },
              achievements: granted.grantedCount ? { earnedIds: granted.earnedIds } : s.achievements,
              legacy: granted.grantedCount ? { ...s.legacy, legacyPoints: granted.legacyPoints } : s.legacy,
            }
          })
        }
      },

      upgradeBaseballTier: (tierId) => {
        const { baseballTiers, currencies, baseballCostAnchorMultiplier } = get()
        const tierIndex = baseballTiers.findIndex((t) => t.id === tierId)
        if (tierIndex === -1) return
        const tier = baseballTiers[tierIndex]
        if (!tier.unlocked) return
        // Anchored config (see tickBaseballTier's own comment) — upgradeBaseCost
        // is one of the three scaled COST fields, so training costs track this
        // save's re-anchored ladder, not the raw reference numbers.
        // baseRevenueMultiplier here is unaffected regardless (never scaled).
        const config = scaledBaseballTiers(baseballCostAnchorMultiplier)[tierIndex]
        const cost = tierUpgradeCost(config, tier.level)
        if (currencies.revenue < cost) return

        const nextLevel = tier.level + 1
        const crossedMilestones = TRAINING_MILESTONE_LEVELS.filter(
          (milestone) => milestone > tier.level && milestone <= nextLevel,
        )

        set((s) => {
          if (crossedMilestones.length === 0) {
            return {
              currencies: { revenue: s.currencies.revenue - cost },
              baseballTiers: s.baseballTiers.map((t, i) => (i === tierIndex ? { ...t, level: nextLevel } : t)),
            }
          }
          let nextId = s.notifications.length ? Math.max(...s.notifications.map((n) => n.id)) + 1 : 1
          const newNotifications = crossedMilestones.map(() => ({
            id: nextId++,
            message: `${config.name} Revenue 2x!`,
          }))
          return {
            currencies: { revenue: s.currencies.revenue - cost },
            baseballTiers: s.baseballTiers.map((t, i) => (i === tierIndex ? { ...t, level: nextLevel } : t)),
            notifications: [...s.notifications, ...newNotifications],
          }
        })
      },

      hireManagerForBaseballTier: (tierId) => {
        const { baseballTiers, currencies, baseballCostAnchorMultiplier } = get()
        const tierIndex = baseballTiers.findIndex((t) => t.id === tierId)
        if (tierIndex === -1) return
        const tier = baseballTiers[tierIndex]
        if (!tier.unlocked || tier.managerHired) return
        // Anchored config (see tickBaseballTier's own comment).
        const cost = scaledBaseballTiers(baseballCostAnchorMultiplier)[tierIndex].managerHireCost
        if (currencies.revenue < cost) return

        set((s) => ({
          currencies: { revenue: s.currencies.revenue - cost },
          baseballTiers: s.baseballTiers.map((t, i) => (i === tierIndex ? { ...t, managerHired: true } : t)),
        }))
      },

      // Unlike soccer's local-game, baseball's own first tier (Tee Time)
      // does NOT start unlocked (see createInitialBaseballTiers) — so this
      // is also how a player enters the sport in the first place, following
      // the exact same locked-card purchase pattern as every other tier
      // rather than a special "first tier is free" case.
      unlockBaseballTier: (tierId) => {
        const { baseballTiers, currencies, legacy, baseballCostAnchorMultiplier } = get()
        const tierIndex = baseballTiers.findIndex((t) => t.id === tierId)
        if (tierIndex === -1) return
        const tier = baseballTiers[tierIndex]
        if (tier.unlocked) return
        // Anchored config (see tickBaseballTier's own comment) — the Legacy
        // Veteran Discount still stacks on top of the anchored unlockCost,
        // exactly as it did on the raw one.
        const cost = Math.round(
          scaledBaseballTiers(baseballCostAnchorMultiplier)[tierIndex].unlockCost *
            unlockCostMultiplier(legacy.permanentUpgrades),
        )
        if (currencies.revenue < cost) return

        set((s) => ({
          currencies: { revenue: s.currencies.revenue - cost },
          baseballTiers: s.baseballTiers.map((t, i) => (i === tierIndex ? { ...t, unlocked: true } : t)),
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
          // Baseball tiers are wiped here too — this button's documented
          // purpose is a true "brand new player" state, which means every
          // sport. resetForLegacy() below now also resets baseball (see that
          // action's own comment); what still separates the two is Legacy
          // itself: this wipes legacyPoints/permanentUpgrades as well, which
          // a prestige never does.
          baseballTiers: createInitialBaseballTiers(),
          // Baseball's cost anchor resets to the floor too — a true
          // brand-new player's baseball economy starts over completely,
          // original unscaled numbers included (see the field's doc comment
          // on GameState). Hardcoded `1` rather than routed through
          // computeBaseballCostAnchorMultiplier because this reset has no
          // surviving economy to measure at all, by definition.
          baseballCostAnchorMultiplier: 1,
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
      // EVERY currently-visible tier is unlocked (allVisibleTiersUnlocked,
      // soccerModule.ts) — not just the single trigger tier this used to
      // check, which let a player hoard Revenue on one tier and skip
      // unlocking the ones in between (tiers can be unlocked in any order —
      // unlockTier() only checks that ONE tier's own cost). Generalizes
      // across every prestige stage automatically: at prestigeCount=0 this
      // requires tiers 0-5 all unlocked; after each later prestige reveals
      // one more hidden tier, the same check requires that one unlocked
      // too, forever — no per-stage special-casing needed.
      //
      // RESETS BOTH SPORTS. This action used to reset ONLY soccer's `tiers`,
      // leaving baseball's unlocked/level/managerHired progress fully intact
      // across a prestige. That was a real, player-confirmed bug, not a
      // design choice: because Revenue is ONE shared pool, a developed
      // baseball economy refilled the wallet almost immediately after every
      // reset, so prestige stopped being the genuine restart-for-permanent-
      // bonuses trade it exists to be. Both sports now reset together:
      //   - soccer  -> createInitialTiers(permanentUpgrades) (unchanged; the
      //     Fast Track permanent upgrade may still pre-unlock its first tiers)
      //   - baseball -> createInitialBaseballTiers(), which puts ALL 11 tiers
      //     back to LOCKED (Tee Time included — baseball deliberately has no
      //     free starting tier the way soccer's Sunday League does, so a true
      //     reset is fully locked, not "first tier free"), level 1, no
      //     manager, zero matches/cumulativeRevenue, and a fresh match state.
      //     Reusing that same helper is exactly how soccer's own reset works,
      //     so neither sport can drift from "what a brand-new player has."
      //
      // `currencies.revenue` was ALREADY reset before this change (one shared
      // pool — a prestige trades away all banked wealth regardless of which
      // sport earned it); that behavior is unchanged, it just no longer
      // stands alone as the only thing touching baseball.
      //
      // The gate condition is deliberately still SOCCER-ONLY
      // (allVisibleTiersUnlocked over `tiers`): baseball is never gated by
      // prestige in either direction — it isn't a prerequisite for
      // prestiging, and prestige never gates baseball's unlocks. This change
      // is about WHAT A RESET WIPES, not about adding any new gating.
      resetForLegacy: () => {
        const { tiers, baseballTiers, legacy } = get()
        if (!allVisibleTiersUnlocked(tiers, legacy.prestigeCount)) return

        // Both sports' earnings feed the reward, since both are now being
        // sacrificed — see totalFranchiseEarnings. The sqrt-based formula in
        // calculateLegacyPoints itself is unchanged; only its INPUT grew.
        const totalEarnings = totalFranchiseEarnings(tiers, baseballTiers)
        const gained = calculateLegacyPoints(totalEarnings)

        set((s) => {
          const nextLegacy: LegacyState = {
            ...s.legacy,
            legacyPoints: s.legacy.legacyPoints + gained,
            hasPrestiged: true,
            prestigeCount: s.legacy.prestigeCount + 1,
          }
          const nextTiers = createInitialTiers(nextLegacy.permanentUpgrades)
          const nextBaseballTiers = createInitialBaseballTiers()
          return {
            legacy: nextLegacy,
            tiers: nextTiers,
            baseballTiers: nextBaseballTiers,
            // Re-anchor baseball's entry costs against the POST-reset economy
            // (both arrays above, already reset), NOT the pre-reset one. The
            // stored multiplier from before this prestige was anchored to
            // wealth the player no longer has, so leaving it in place would
            // price freshly-RELOCKED baseball tiers for an economy that just
            // got wiped — a confusing, broken-feeling mismatch where Tee Time
            // still costs millions on what is otherwise a fresh start. In
            // practice the post-reset arrays have no managers hired, so
            // `tierIncomeRatePerSecond` reports 0 for every tier and this
            // floors to 1 (baseball's own unscaled reference numbers) — the
            // correct pricing for a player starting over. It is computed from
            // the real arrays rather than hardcoded to 1 so it stays correct
            // by construction if a future permanent upgrade ever grants
            // post-reset income (e.g. a pre-hired manager). Uses the SAME
            // shared helper SCHEMA_MIGRATIONS[5] uses to establish this value
            // in the first place — never a second, parallel derivation.
            baseballCostAnchorMultiplier: computeBaseballCostAnchorMultiplier(
              nextTiers,
              nextBaseballTiers,
              nextLegacy.permanentUpgrades,
            ),
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
        baseballTiers: state.baseballTiers,
        baseballCostAnchorMultiplier: state.baseballCostAnchorMultiplier,
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
      // Franchise tab's DEV wipe button, formerly a separate /settings
      // route — see CLAUDE.md's tabbed-navigation amendment). Restoring the original
      // silently-keep-defaults behavior explicitly here, rather than
      // depending on an accidental throw deep in a promise chain to keep
      // providing it.
      merge: (persistedState, currentState) => {
        const merged = { ...currentState, ...(persistedState as Partial<GameState>) }
        merged.notifications = currentState.notifications
        if (!Array.isArray(merged.tiers) || merged.tiers.length !== SOCCER_VENTURE_TIERS.length) {
          merged.tiers = currentState.tiers
        }
        // Same never-trust-the-shape guard, extended to baseball's own
        // tier array now that it exists too — a hand-edited or corrupted
        // `baseballTiers` gets exactly the same silent-fallback-to-fresh-
        // defaults treatment as `tiers` above, for the identical reason.
        if (!Array.isArray(merged.baseballTiers) || merged.baseballTiers.length !== BASEBALL_VENTURE_TIERS.length) {
          merged.baseballTiers = currentState.baseballTiers
        }
        // lifetimeStats gets the same never-trust-the-shape treatment as
        // tiers/baseballTiers above, via the SAME sanitizeLifetimeStats()
        // SCHEMA_MIGRATIONS[2] uses — not a second, independently-written
        // guard. This matters even for a save already AT the current
        // schema version: migrate() only runs on a version MISMATCH, so a
        // corrupted-but-current-version lifetimeStats (a hand-edited
        // `null`, or one missing soccerWins/baseballWins) would otherwise
        // never pass through SCHEMA_MIGRATIONS[2] at all and would sail
        // through this blind spread unrepaired — an adversarial review
        // caught this crashing AchievementsPanel.tsx on the very next
        // render (a null case) or silently poisoning soccerWins/
        // baseballWins to NaN forever on the next win in that sport (a
        // missing-subfield case). Runs unconditionally, whether or not
        // migrate() already sanitized it, since re-validating an
        // already-valid object is a harmless no-op.
        merged.lifetimeStats = sanitizeLifetimeStats(merged.lifetimeStats)
        // Same never-trust-the-shape treatment for baseball's cost anchor
        // multiplier — a corrupted-but-current-version value (hand-edited
        // null/NaN/negative, or simply absent on a save that somehow reports
        // v6 without one) would otherwise poison every baseball cost derived
        // from it (see scaledBaseballTiers). sanitizeBaseballCostAnchorMultiplier
        // collapses anything invalid back to the 1 floor (original unscaled
        // numbers), the safe default — never below it. Runs unconditionally,
        // same as the lifetimeStats guard above.
        merged.baseballCostAnchorMultiplier = sanitizeBaseballCostAnchorMultiplier(
          merged.baseballCostAnchorMultiplier,
        )
        // `achievements` gets the same never-trust-the-shape guard as
        // tiers/baseballTiers/lifetimeStats above — the ONE unconditionally-read
        // persisted field that previously lacked one. SCHEMA_MIGRATIONS[5]
        // hard-guards earnedIds, but that only runs on a version MISMATCH; a
        // save already AT the current version with a corrupted `achievements`
        // (a hand-edited `null`, or a non-array `earnedIds`) skips migrate()
        // entirely and would crash on the first render (AchievementsPanel's
        // `new Set(s.achievements.earnedIds)`) or the first tick
        // (applyEarnedAchievements' `[...earnedIds]`). Falling back to fresh
        // empty achievements is the same silently-keep-safe-defaults posture as
        // the guards above. An adversarial review caught this gap.
        if (!Array.isArray(merged.achievements?.earnedIds)) {
          merged.achievements = createInitialAchievements()
        }
        return merged
      },
    },
  ),
)
