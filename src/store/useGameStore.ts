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
import { scaledRevenueReward } from '../engine/economy'
import {
  type ActiveObjective,
  type ObjectiveStatKey,
  type PeriodicObjectiveKind,
  type PeriodicObjectiveState,
  OBJECTIVE_STAT_SCOPES,
  objectiveConfigById,
  objectiveProgress,
  fillObjectives,
  sanitizeObjectives,
  resolveObjectiveTarget,
  ACTIVE_OBJECTIVE_TARGET,
  createPeriodicObjectiveState,
  periodicObjectiveConfigById,
  resolvePeriodicObjective,
  rebaselinePeriodicObjective,
  sanitizePeriodicObjectiveState,
} from '../engine/objectives'
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
  revealedTierCount,
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

/**
 * How many of a sport's CURRENTLY-VISIBLE tiers are unlocked, as an
 * `{unlocked, visible}` pair — the hub's "6/11 unlocked" readout.
 *
 * `visibleCount` is supplied by the caller because "how many tiers exist
 * right now" is a per-sport rule, and each caller must pass the SAME value
 * that sport's own screen renders with: soccer passes
 * `revealedTierCount(prestigeCount)` (the identical function SoccerTab
 * slices its card list with, so the hub's denominator can never disagree
 * with the number of cards actually on screen), while baseball passes its
 * full ladder length (BaseballTab renders every tier, revealed or not —
 * baseball has no prestige-reveal mechanic). Deriving the count here from
 * the live store array, rather than from any separately-tracked counter,
 * is what keeps the numerator honest too.
 *
 * Tolerates a malformed element (a hand-edited save whose array is the
 * right length but has a null/primitive entry) by simply not counting it,
 * rather than throwing during a render — same never-trust-persisted-shape
 * posture as `totalFranchiseEarnings` above.
 */
export function visibleTierUnlockProgress(
  tiers: { unlocked: boolean }[],
  visibleCount: number,
): { unlocked: number; visible: number } {
  const visible = Math.max(0, Math.min(visibleCount, tiers.length))
  let unlocked = 0
  for (let i = 0; i < visible; i++) {
    if (tiers[i]?.unlocked) unlocked++
  }
  return { unlocked, visible }
}

/**
 * The generic stats record the Objectives system measures against — the
 * objective analogue of the record `applyEarnedAchievements` builds for
 * achievements, and built the same way: from state THIS STORE ALREADY
 * TRACKS, never a new parallel counter.
 *
 * Every entry reuses an existing shared derivation rather than recomputing
 * anything (see CLAUDE.md's "one authoritative source" rule):
 *   - the three win counters come straight off `lifetimeStats`, the same
 *     fields the achievement lines read;
 *   - `franchiseEarnings` is `totalFranchiseEarnings`, the exact function
 *     the Legacy panel previews and `resetForLegacy()` award Legacy Points
 *     from;
 *   - `tiersUnlocked` sums `visibleTierUnlockProgress`, the same helper the
 *     Hub's "N/M unlocked" readout uses (soccer counted over its revealed
 *     window via `revealedTierCount`, exactly as SoccerTab slices its
 *     cards; baseball over its full ladder, as BaseballTab renders it);
 *   - `totalTierLevels` is a plain sum of the live `level` fields.
 * A malformed/hand-edited `level` is coerced to 0 rather than poisoning the
 * sum to NaN, matching this file's standing defensive posture.
 */
export function selectObjectiveStats(
  tiers: { unlocked: boolean; level: number; cumulativeRevenue: number }[],
  baseballTiers: { unlocked: boolean; level: number; cumulativeRevenue: number }[],
  lifetimeStats: LifetimeStats,
  prestigeCount: number,
): Record<ObjectiveStatKey, number> {
  const levelSum = (acc: number, t: { level: number }) =>
    acc + (Number.isFinite(t?.level) ? t.level : 0)
  const soccerUnlocked = visibleTierUnlockProgress(tiers, revealedTierCount(prestigeCount)).unlocked
  const baseballUnlocked = visibleTierUnlockProgress(baseballTiers, baseballTiers.length).unlocked
  return {
    totalWins: lifetimeStats.totalWins,
    soccerWins: lifetimeStats.soccerWins,
    baseballWins: lifetimeStats.baseballWins,
    franchiseEarnings: totalFranchiseEarnings(tiers, baseballTiers),
    totalTierLevels: tiers.reduce(levelSum, 0) + baseballTiers.reduce(levelSum, 0),
    tiersUnlocked: soccerUnlocked + baseballUnlocked,
    // Exposed separately purely as an eligibility signal — see
    // ObjectiveConfig.requiresStatPositive: baseball-specific objectives
    // must not be drawn for a player who owns no baseball tier, since they
    // could never progress it.
    baseballTiersUnlocked: baseballUnlocked,
  }
}

/**
 * The first set of objectives for a brand-new save.
 *
 * Baselines are captured from the REAL fresh-game state, not from zeros:
 * a new save already has every tier at level 1 (so `totalTierLevels` is 22,
 * not 0) and at least one tier unlocked. Baselining at 0 would make a
 * "improve training 5 times" objective read as instantly complete on the
 * very first render — so this builds the actual initial tier arrays and runs
 * them through the same `selectObjectiveStats` derivation every later check uses.
 * Income rate is genuinely 0 here (nothing is managed yet), which
 * `resolveObjectiveTarget` floors correctly for any income-scaled target.
 */
function createInitialObjectives(permanentUpgrades: PermanentUpgradeLevels): ActiveObjective[] {
  const stats = selectObjectiveStats(
    createInitialTiers(permanentUpgrades),
    createInitialBaseballTiers(),
    createInitialLifetimeStats(),
    0,
  )
  return fillObjectives([], stats, 0)
}

/**
 * The first Daily / Weekly slot for a brand-new (or fully wiped) save.
 *
 * Baselined from the same real fresh-game state `createInitialObjectives`
 * uses, for the same reason: a new save already has every tier at level 1,
 * so baselining a training objective at zero would present it as instantly
 * complete. Both boundary clocks are anchored to `nowMs`, so a player who
 * starts at 23:58 gets their first daily reset two minutes later (the
 * calendar-day rule, honestly applied) and their first weekly a full 7 days
 * out.
 */
function createInitialPeriodicObjective(
  kind: PeriodicObjectiveKind,
  permanentUpgrades: PermanentUpgradeLevels,
  nowMs: number = Date.now(),
): PeriodicObjectiveState {
  const stats = selectObjectiveStats(
    createInitialTiers(permanentUpgrades),
    createInitialBaseballTiers(),
    createInitialLifetimeStats(),
    0,
  )
  return createPeriodicObjectiveState(kind, stats, 0, nowMs)
}

/**
 * Grants any newly-complete objectives and refills the active set, applying
 * rewards atomically within the caller's own `set()` — the exact shape (and
 * the exact lazy `getIncomeRatePerSecond` thunk contract) as
 * `applyEarnedAchievements` below, and called from the same four places, so
 * the two systems stay in lockstep about WHEN progress is evaluated.
 *
 * Rewards go through the SHARED `scaledRevenueReward` (engine/economy.ts) —
 * the identical function achievements' own `scaledRevenue` rewards use, per
 * the requirement to reuse the real reward machinery rather than
 * approximate a second copy of it.
 *
 * The thunk is called at most once per invocation even when several
 * objectives complete at the same instant (memoised into `rate`), so the
 * rare multi-completion tick doesn't loop over every tier of both sports
 * more than necessary — and, more importantly, so simultaneous completions
 * are all priced off ONE consistent snapshot of the economy rather than
 * subtly different ones.
 */
function applyCompletedObjectives(
  objectives: readonly ActiveObjective[],
  stats: Record<string, number>,
  baseRevenue: number,
  getIncomeRatePerSecond: () => number,
  random: () => number = Math.random,
): { objectives: ActiveObjective[]; revenue: number; completedCount: number } {
  const completed = objectives.filter((a) => objectiveProgress(a, stats)?.complete)
  const needsTopUp = objectives.length - completed.length < ACTIVE_OBJECTIVE_TARGET

  // The overwhelmingly common case: nothing completed and the set is
  // already full. Bail before touching the income rate, which loops every
  // tier of both sports doing real probability math — this runs on EVERY
  // tick, so it must stay cheap when there is nothing to do.
  if (completed.length === 0 && !needsTopUp) {
    return { objectives: [...objectives], revenue: baseRevenue, completedCount: 0 }
  }

  let rate: number | null = null
  const rateOnce = () => (rate ??= getIncomeRatePerSecond())

  let revenue = baseRevenue
  for (const active of completed) {
    const config = objectiveConfigById(active.configId)
    if (!config) continue
    revenue += scaledRevenueReward(
      config.rewardIncomeRateSeconds,
      config.rewardMinAmount,
      rateOnce(),
    )
  }

  const completedIds = new Set(completed.map((a) => a.configId))
  const remaining = objectives.filter((a) => !completedIds.has(a.configId))
  // Baselines for the replacements are captured from the SAME `stats`
  // snapshot the completion was judged against, so a replacement can never
  // be accidentally pre-credited with progress the player already banked.
  // This also self-heals a set left short by merge()'s sanitizer (a
  // corrupted/stale persisted entry dropped on load).
  // The just-completed ids are excluded from the refill so a finished
  // objective can't reappear in the same frame it was completed in.
  return {
    objectives: fillObjectives(remaining, stats, rateOnce(), random, [...completedIds]),
    revenue,
    completedCount: completed.length,
  }
}

/**
 * Repairs and tops up a persisted `objectives` array at load time — the
 * function `merge()` needs and whose absence an adversarial review caught
 * (two comments referenced an `ensureObjectives` that was never written).
 *
 * Does three things `sanitizeObjectives` alone cannot, because they need a
 * live stats snapshot:
 *  1. Drops any entry whose `baseline` EXCEEDS the current stat. Such an
 *     objective can never complete (progress clamps at 0) and never rotates
 *     (the top-up only fires on a COUNT shortfall), so it would sit frozen
 *     at 0% forever, presenting as a healthy-looking but dead panel. This is
 *     reachable when merge() falls back to fresh default tiers while passing
 *     persisted objectives through verbatim — the baselines then describe an
 *     economy that no longer exists.
 *  2. Tops the set back up to the full 2-3, so a save whose entries were
 *     dropped (corrupt, stale, or referencing a removed pool id) doesn't
 *     hydrate with an empty Objectives section — ObjectivesPanel renders
 *     nothing at length 0, so the Hub section would silently vanish.
 *  3. Falls back to the caller's known-good default on ANY throw, keeping
 *     the same never-throw-during-hydrate posture the rest of merge() has.
 */
function ensureObjectives(
  candidate: unknown,
  tiers: VentureTier[],
  baseballTiers: BaseballVentureTier[],
  lifetimeStats: LifetimeStats,
  prestigeCount: number,
  permanentUpgrades: PermanentUpgradeLevels,
  baseballCostAnchorMultiplier: number,
  fallback: ActiveObjective[],
): ActiveObjective[] {
  try {
    const stats = selectObjectiveStats(tiers, baseballTiers, lifetimeStats, prestigeCount)
    let rate = 0
    try {
      rate = currentAggregateIncomeRatePerSecond(
        tiers,
        baseballTiers,
        globalRevenueMultiplier(permanentUpgrades),
        baseballCostAnchorMultiplier,
      )
    } catch {
      rate = 0
    }
    const kept = sanitizeObjectives(candidate).filter((a) => {
      const config = objectiveConfigById(a.configId)
      return config ? a.baseline <= (stats[config.statTracked] ?? 0) : false
    })
    return fillObjectives(kept, stats, rate)
  } catch {
    return fallback
  }
}

/**
 * Repairs a persisted Daily/Weekly slot at load time — the periodic
 * counterpart of `ensureObjectives` above, and there for the identical
 * reason: a save already AT the current schema version skips `migrate()`
 * entirely, so `merge()` is the only place a corrupted-but-current slot ever
 * gets looked at.
 *
 * Three repairs, in order of how badly they'd fail otherwise:
 *  1. An unusable slot (missing, non-object, or with a non-string date /
 *     non-finite timestamp) is replaced wholesale with a fresh one anchored
 *     to now. Leaving it would crash the panel on the first render or freeze
 *     the boundary forever. Crucially the replacement is baselined against
 *     THIS SAVE'S live stats, not against the caller's fresh-game fallback:
 *     that fallback is baselined for a brand-new player (totalTierLevels 22,
 *     zero wins), so handing it to a veteran save would produce an INSTANTLY
 *     COMPLETE objective that pays out on the next tick — and for the weekly
 *     slot that is a free Legacy Point grant, repeatable by re-corrupting the
 *     field. The fallback is therefore reserved for the throw path alone,
 *     where no live stats snapshot could be obtained at all.
 *  2. A structurally-valid slot whose OBJECTIVE is malformed (or names a
 *     config this kind's pool doesn't have) keeps its boundary timestamps
 *     and drops the objective to null — the next resolve redraws it without
 *     also gifting a fresh period, which is what stops a corrupted save from
 *     being a way to skip a weekly's 7-day wait.
 *  3. A stale baseline ABOVE the live stat is re-baselined rather than
 *     dropped. It would otherwise clamp at 0% and never complete, and
 *     (unlike a rotating objective) nothing would rotate it out before its
 *     boundary. Reachable whenever merge() falls back to fresh default tiers
 *     while passing a persisted slot through verbatim.
 * Wrapped so a throw can never break hydration, matching the rest of merge().
 */
function ensurePeriodicObjective(
  kind: PeriodicObjectiveKind,
  candidate: unknown,
  tiers: VentureTier[],
  baseballTiers: BaseballVentureTier[],
  lifetimeStats: LifetimeStats,
  prestigeCount: number,
  permanentUpgrades: PermanentUpgradeLevels,
  baseballCostAnchorMultiplier: number,
  fallback: PeriodicObjectiveState,
): PeriodicObjectiveState {
  try {
    const stats = selectObjectiveStats(tiers, baseballTiers, lifetimeStats, prestigeCount)
    const sanitized = sanitizePeriodicObjectiveState(kind, candidate)
    if (!sanitized) {
      let rate = 0
      try {
        rate = currentAggregateIncomeRatePerSecond(
          tiers,
          baseballTiers,
          globalRevenueMultiplier(permanentUpgrades),
          baseballCostAnchorMultiplier,
        )
      } catch {
        rate = 0
      }
      return createPeriodicObjectiveState(kind, stats, rate, Date.now())
    }
    const active = sanitized.objective
    if (!active) return sanitized
    const config = periodicObjectiveConfigById(kind, active.configId)
    if (!config) return { ...sanitized, objective: null, completed: false }
    const live = stats[config.statTracked] ?? 0
    if (active.baseline > live) {
      return { ...sanitized, objective: { ...active, baseline: live } }
    }
    return sanitized
  } catch {
    return fallback
  }
}

/**
 * Rewrites the baseline of every RUN-SCOPED objective to the supplied
 * (post-reset) stats, leaving lifetime-scoped ones untouched — see
 * OBJECTIVE_STAT_SCOPES (engine/objectives.ts) for why the distinction
 * exists and `resetForLegacy` for where it's applied. Pure; returns a new
 * array. An objective whose config no longer exists is passed through
 * unchanged and gets dropped later by `sanitizeObjectives`.
 */
function rebaselineRunScopedObjectives(
  objectives: readonly ActiveObjective[],
  postResetStats: Record<ObjectiveStatKey, number>,
  postResetIncomeRate: number,
): ActiveObjective[] {
  return objectives.map((active) => {
    const config = objectiveConfigById(active.configId)
    if (!config) return active
    if (OBJECTIVE_STAT_SCOPES[config.statTracked] !== 'run') return active
    // An income-scaled TARGET also has to be re-resolved, not just the
    // baseline: a target sized against the pre-prestige economy (millions of
    // Revenue per second) carried into a freshly-reset one takes tens of
    // minutes instead of its designed ~90 seconds. Re-resolving is only safe
    // because resolveObjectiveTarget now floors the RATE
    // (OBJECTIVE_FLOOR_INCOME_RATE) — before that fix, re-resolving here
    // would have produced a target of 1, since resetForLegacy clears every
    // manager and so zeroes the measured rate. An adversarial review raised
    // both halves of this; they only resolve together.
    const target =
      config.targetKind === 'incomeRateSeconds'
        ? resolveObjectiveTarget(config, postResetIncomeRate)
        : active.target
    return { ...active, baseline: postResetStats[config.statTracked] ?? 0, target }
  })
}

/**
 * The one call every tick branch makes: derives the objective stats record
 * from the post-update state, then grants/refills via
 * `applyCompletedObjectives`. Exists so all four tick branches (soccer and
 * baseball × completion and non-completion) share ONE wiring path rather
 * than four near-identical copies — the same reason
 * `applyEarnedAchievements` is shared across those same four sites.
 *
 * Called from BOTH branches, not just completion, deliberately: objectives
 * track stats that move on EVERY tick (franchiseEarnings, and
 * totalTierLevels/tiersUnlocked which move on purchases), not only on match
 * completion, so a completion-only check would leave an objective sitting
 * finished-but-ungranted until the next match happened to end. This is the
 * same lesson `applyEarnedAchievements`' own doc comment records.
 */
function resolveObjectivesForState(
  objectives: readonly ActiveObjective[],
  dailyObjective: PeriodicObjectiveState,
  weeklyObjective: PeriodicObjectiveState,
  tiers: { unlocked: boolean; level: number; cumulativeRevenue: number }[],
  baseballTiers: { unlocked: boolean; level: number; cumulativeRevenue: number }[],
  lifetimeStats: LifetimeStats,
  prestigeCount: number,
  baseRevenue: number,
  getIncomeRatePerSecond: () => number,
  nowMs: number = Date.now(),
): ObjectiveResolution {
  const stats = selectObjectiveStats(tiers, baseballTiers, lifetimeStats, prestigeCount)
  // ONE memoised rate snapshot shared by the rotating set AND both periodic
  // slots, so several rewards landing in the same frame are all priced off
  // the same instant of the economy — and so the (expensive) aggregate rate
  // is computed at most once even when all three tiers pay out together.
  let rate: number | null = null
  const rateOnce = () => (rate ??= getIncomeRatePerSecond())

  const rotating = applyCompletedObjectives(objectives, stats, baseRevenue, rateOnce)
  const periodic = resolvePeriodicObjectivePair(
    dailyObjective,
    weeklyObjective,
    stats,
    nowMs,
    rateOnce,
  )
  return {
    objectives: rotating.objectives,
    daily: periodic.daily,
    weekly: periodic.weekly,
    revenue: rotating.revenue + periodic.revenueReward,
    legacyPointsReward: periodic.legacyPointsReward,
    completedCount: rotating.completedCount + periodic.completedCount,
  }
}

interface ObjectiveResolution {
  objectives: ActiveObjective[]
  daily: PeriodicObjectiveState
  weekly: PeriodicObjectiveState
  /** Absolute Revenue after every objective tier's rewards (the caller's
   *  `baseRevenue` plus rotating plus daily plus weekly). */
  revenue: number
  /** Legacy Points to ADD — a delta, and non-zero ONLY when a weekly
   *  objective completed (the rotating and daily tiers never carry any). */
  legacyPointsReward: number
  completedCount: number
}

/**
 * Resolves BOTH periodic slots (grant + boundary reset) against one shared
 * stats snapshot and one shared income-rate snapshot. See
 * `resolvePeriodicObjective` (engine/objectives.ts) for the per-slot rules;
 * this is purely the "there are two of them" wiring, kept in one place so
 * the store's tick path, its purchase paths and the idle refresh action can
 * never drift in how they evaluate the two.
 */
function resolvePeriodicObjectivePair(
  daily: PeriodicObjectiveState,
  weekly: PeriodicObjectiveState,
  stats: Record<string, number>,
  nowMs: number,
  getIncomeRatePerSecond: () => number,
): {
  daily: PeriodicObjectiveState
  weekly: PeriodicObjectiveState
  revenueReward: number
  legacyPointsReward: number
  completedCount: number
  /** True when anything at all changed — lets the idle refresh action skip
   *  `set()` entirely on the overwhelmingly common no-op wake-up, so it
   *  doesn't churn a re-render (or a localStorage write) every 30 seconds. */
  changed: boolean
} {
  const d = resolvePeriodicObjective('daily', daily, stats, nowMs, getIncomeRatePerSecond)
  const w = resolvePeriodicObjective('weekly', weekly, stats, nowMs, getIncomeRatePerSecond)
  return {
    daily: d.state,
    weekly: w.state,
    revenueReward: d.revenueReward + w.revenueReward,
    legacyPointsReward: d.legacyPointsReward + w.legacyPointsReward,
    completedCount: (d.granted ? 1 : 0) + (w.granted ? 1 : 0),
    changed: d.state !== daily || w.state !== weekly,
  }
}

/** Returns `legacy` unchanged when the point total is unchanged, so an
 *  untouched Legacy object keeps its referential identity and doesn't cause
 *  needless re-renders on the (vast majority of) frames that grant nothing. */
function withLegacyPoints(legacy: LegacyState, nextPoints: number): LegacyState {
  return nextPoints === legacy.legacyPoints ? legacy : { ...legacy, legacyPoints: nextPoints }
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
      // Routed through the SHARED scaledRevenueReward (engine/economy.ts) —
      // the same function the Objectives system grants its rewards with, so
      // the two reward systems cannot ship drifting copies of this formula.
      // That helper also owns the non-finite-rate guard and the floor
      // semantics; see its doc comment for why both matter.
      revenue += scaledRevenueReward(
        reward.incomeRateSeconds,
        reward.minAmount,
        getIncomeRatePerSecond(),
      )
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
  /**
   * The 2-3 currently-assigned short-term Objectives shown on the Hub (see
   * engine/objectives.ts and CLAUDE.md's "Objectives" section). Persisted,
   * because each entry carries the BASELINE captured when it was assigned —
   * that baseline is the whole mechanism by which "win 5 MORE matches" means
   * anything without a session concept, so losing it on reload would silently
   * restart or corrupt every in-flight objective.
   */
  objectives: ActiveObjective[]
  /**
   * The single active DAILY objective and its calendar-day boundary state
   * (see PeriodicObjectiveState in engine/objectives.ts). Persisted for the
   * same reason `objectives` is — it carries the baseline that makes "win
   * 100 MORE matches today" mean anything — plus two more:
   *   - `lastResetDate` IS the boundary. Losing it on reload would hand the
   *     player a brand-new daily on every page refresh.
   *   - `completed` is what stops an already-rewarded daily from being paid
   *     again on the next tick.
   */
  dailyObjective: PeriodicObjectiveState
  /** The single active WEEKLY objective and its rolling-7-day boundary. Same
   *  reasoning as `dailyObjective`, and rather more load-bearing: this is
   *  the only slot in the game that grants Legacy Points, so its
   *  `lastResetMs` + `completed` pair is exactly what enforces "at most
   *  WEEKLY_LEGACY_POINT_REWARD points per 7-day window". */
  weeklyObjective: PeriodicObjectiveState
  notifications: MilestoneNotification[]
  tickTier: (tierId: string) => void
  upgradeTier: (tierId: string) => void
  hireManagerForTier: (tierId: string) => void
  unlockTier: (tierId: string) => void
  tickBaseballTier: (tierId: string) => void
  upgradeBaseballTier: (tierId: string) => void
  hireManagerForBaseballTier: (tierId: string) => void
  unlockBaseballTier: (tierId: string) => void
  /**
   * Re-evaluates BOTH periodic slots against the wall clock — the idle
   * counterpart to the evaluation the tick and purchase paths already do.
   *
   * Needed because a boundary can pass with nothing else happening at all: a
   * player who leaves the app open past local midnight with no manager
   * hired anywhere produces no ticks and no purchases, so without a timer
   * their daily would sit expired until they next did something. Driven by
   * `usePeriodicObjectives` (hooks/useMatchTicker.ts) and a no-op on the
   * overwhelming majority of wake-ups — it skips `set()` entirely unless a
   * boundary actually passed, so it costs nothing per-render or in
   * localStorage writes.
   */
  refreshPeriodicObjectives: () => void
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
const CURRENT_SCHEMA_VERSION = 8

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
  // Version 6 -> 7: the Objectives system (see engine/objectives.ts and
  // CLAUDE.md's "Objectives" section) adds a new persisted `objectives`
  // array — a genuinely new field in `partialize`, which is exactly the case
  // this project's schema-versioning convention exists for.
  //
  // An existing save must arrive with a FULL, VALID set of objectives, not
  // an empty/broken one, so this assigns them here rather than relying on a
  // later self-heal. Crucially their baselines are captured from THIS SAVE'S
  // CURRENT stats, not from zero: a veteran save has hundreds of wins and
  // dozens of tier levels banked, and baselining at 0 would hand them 2-3
  // objectives that are all instantly complete (and would then pay out on
  // the very next tick for work done long before the system existed).
  //
  // Everything the baseline needs is derived through the same shared
  // `selectObjectiveStats` every later check uses. Both tier arrays are treated as
  // empty unless they're already exactly the expected length (mirroring
  // merge()'s own guard and SCHEMA_MIGRATIONS[5]), and the whole thing is
  // try/caught, because an uncaught throw in a migration step is swallowed
  // by zustand's persist hydrate and DISCARDS THE ENTIRE MIGRATION — the
  // same failure mode SCHEMA_MIGRATIONS[5]'s own comment documents. On any
  // throw the save still migrates, just with objectives baselined at zero
  // for whichever stats couldn't be read; `ensureObjectives` on the next
  // tick then tops up anything missing.
  6: (state: any) => {
    const safeSoccerTiers =
      Array.isArray(state?.tiers) && state.tiers.length === SOCCER_VENTURE_TIERS.length ? state.tiers : []
    const safeBaseballTiers =
      Array.isArray(state?.baseballTiers) && state.baseballTiers.length === BASEBALL_VENTURE_TIERS.length
        ? state.baseballTiers
        : []
    const permanentUpgrades = state?.legacy?.permanentUpgrades ?? createInitialPermanentUpgrades()
    const prestigeCount = Number.isFinite(state?.legacy?.prestigeCount) ? state.legacy.prestigeCount : 0

    // selectObjectiveStats is fully null-tolerant, so it stays OUTSIDE the
    // try — only currentAggregateIncomeRatePerSecond can throw (it
    // dereferences `tier.unlocked`, which a null element in a right-length
    // array breaks). Wrapping both together, as an earlier version did,
    // meant one bad tier element discarded a perfectly computable stats
    // snapshot and produced ZERO objectives. This is the same narrow-the-try
    // shape SCHEMA_MIGRATIONS[5] already uses; an adversarial review caught
    // that it hadn't been carried over.
    const stats = selectObjectiveStats(
      safeSoccerTiers,
      safeBaseballTiers,
      sanitizeLifetimeStats(state?.lifetimeStats),
      prestigeCount,
    )
    let incomeRate = 0
    try {
      incomeRate = currentAggregateIncomeRatePerSecond(
        safeSoccerTiers,
        safeBaseballTiers,
        globalRevenueMultiplier(permanentUpgrades),
        sanitizeBaseballCostAnchorMultiplier(state?.baseballCostAnchorMultiplier),
      )
    } catch {
      incomeRate = 0
    }
    const objectives = fillObjectives(sanitizeObjectives(state?.objectives), stats, incomeRate)

    return { ...state, objectives }
  },
  // Version 7 -> 8: the Daily and Weekly objective tiers (see the
  // DAILY/WEEKLY section of engine/objectives.ts). Two genuinely new
  // persisted fields — `dailyObjective` and `weeklyObjective`, each carrying
  // its own objective, completion flag and reset boundary — which is exactly
  // the case this project's schema-versioning convention exists for.
  //
  // An existing save must arrive with a full, VALID pair, not an empty or
  // half-formed one, so both are generated here rather than left to a
  // load-time self-heal. Three properties matter, and all three follow
  // directly from how the rest of this system is specified:
  //   1. BASELINED FROM THIS SAVE'S CURRENT STATS, never from zero — for the
  //      identical reason SCHEMA_MIGRATIONS[6] does it for the rotating set:
  //      a veteran save has hundreds of wins and dozens of tier levels
  //      banked, and a zero baseline would present both new objectives as
  //      already complete and pay them out (including the weekly's Legacy
  //      Points) on the very next tick, for work done long before either
  //      tier existed.
  //   2. BOTH BOUNDARIES ANCHORED TO NOW, so the migrating player gets a
  //      full fresh day and a full fresh 7 days starting from this load —
  //      never a window that is already partly or wholly expired.
  //   3. NO CATCH-UP, by construction: there is exactly one daily and one
  //      weekly, regardless of how long the save sat unopened. Missed
  //      periods are not a thing that can be owed.
  // Same defensive shape as the two migration steps above: tier arrays are
  // treated as empty unless already exactly the expected length, the
  // null-tolerant `selectObjectiveStats` stays OUTSIDE the try, and only the
  // throw-prone income-rate call is wrapped — an uncaught throw in a
  // migration step is swallowed by zustand's persist hydrate and DISCARDS
  // THE ENTIRE MIGRATION.
  7: (state: any) => {
    const safeSoccerTiers =
      Array.isArray(state?.tiers) && state.tiers.length === SOCCER_VENTURE_TIERS.length ? state.tiers : []
    const safeBaseballTiers =
      Array.isArray(state?.baseballTiers) && state.baseballTiers.length === BASEBALL_VENTURE_TIERS.length
        ? state.baseballTiers
        : []
    const permanentUpgrades = state?.legacy?.permanentUpgrades ?? createInitialPermanentUpgrades()
    const prestigeCount = Number.isFinite(state?.legacy?.prestigeCount) ? state.legacy.prestigeCount : 0

    const stats = selectObjectiveStats(
      safeSoccerTiers,
      safeBaseballTiers,
      sanitizeLifetimeStats(state?.lifetimeStats),
      prestigeCount,
    )
    let incomeRate = 0
    try {
      incomeRate = currentAggregateIncomeRatePerSecond(
        safeSoccerTiers,
        safeBaseballTiers,
        globalRevenueMultiplier(permanentUpgrades),
        sanitizeBaseballCostAnchorMultiplier(state?.baseballCostAnchorMultiplier),
      )
    } catch {
      incomeRate = 0
    }
    const now = Date.now()
    return {
      ...state,
      dailyObjective: createPeriodicObjectiveState('daily', stats, incomeRate, now),
      weeklyObjective: createPeriodicObjectiveState('weekly', stats, incomeRate, now),
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
      // A brand-new save gets its first full set of objectives immediately,
      // baselined against real fresh-game state — so the Hub's Objectives
      // section is never empty, even on the very first render.
      objectives: createInitialObjectives(createInitialLegacy().permanentUpgrades),
      // Both periodic slots exist from the very first render too, each with
      // its boundary clock anchored to the moment the save was created.
      dailyObjective: createInitialPeriodicObjective('daily', createInitialLegacy().permanentUpgrades),
      weeklyObjective: createInitialPeriodicObjective('weekly', createInitialLegacy().permanentUpgrades),
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


            // Objectives share this exact evaluation point with achievements
            // (see resolveObjectivesForState) — same post-update state, same
            // lazy income-rate thunk, same atomic set(). `granted.revenue`
            // is threaded in as the base so both systems' rewards stack
            // within one frame rather than one clobbering the other.
            const objectiveResult = resolveObjectivesForState(
              s.objectives,
              s.dailyObjective,
              s.weeklyObjective,
              updatedTiers,
              s.baseballTiers,
              { ...s.lifetimeStats, totalWins, soccerWins },
              s.legacy.prestigeCount,
              granted.revenue,
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
              currencies: { revenue: objectiveResult.revenue },
              lifetimeStats: { ...s.lifetimeStats, totalWins, soccerWins },
              achievements: granted.grantedCount ? { earnedIds: granted.earnedIds } : s.achievements,
              // Achievement Legacy Points and a completed WEEKLY objective's
              // Legacy Points stack in the same frame — `granted.legacyPoints`
              // already includes the balance plus any achievement award, so
              // the weekly's delta is simply added on top.
              legacy: withLegacyPoints(s.legacy, granted.legacyPoints + objectiveResult.legacyPointsReward),
              objectives: objectiveResult.objectives,
              dailyObjective: objectiveResult.daily,
              weeklyObjective: objectiveResult.weekly,
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


            // Objectives share this exact evaluation point with achievements
            // (see resolveObjectivesForState) — same post-update state, same
            // lazy income-rate thunk, same atomic set(). `granted.revenue`
            // is threaded in as the base so both systems' rewards stack
            // within one frame rather than one clobbering the other.
            const objectiveResult = resolveObjectivesForState(
              s.objectives,
              s.dailyObjective,
              s.weeklyObjective,
              updatedTiers,
              s.baseballTiers,
              s.lifetimeStats,
              s.legacy.prestigeCount,
              granted.revenue,
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
              currencies: { revenue: objectiveResult.revenue },
              achievements: granted.grantedCount ? { earnedIds: granted.earnedIds } : s.achievements,
              legacy: withLegacyPoints(s.legacy, granted.legacyPoints + objectiveResult.legacyPointsReward),
              objectives: objectiveResult.objectives,
              dailyObjective: objectiveResult.daily,
              weeklyObjective: objectiveResult.weekly,
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
          const nextTiers = s.tiers.map((t, i) => (i === tierIndex ? { ...t, level: nextLevel } : t))
          // A purchase moves `totalTierLevels`, which objectives track — so
          // objectives MUST be resolved here, not only on the tick path. See
          // resolveObjectivesForState's own doc comment.
          const resolved = resolveObjectivesForState(
            s.objectives,
            s.dailyObjective,
            s.weeklyObjective,
            nextTiers,
            s.baseballTiers,
            s.lifetimeStats,
            s.legacy.prestigeCount,
            s.currencies.revenue - cost,
            () =>
              currentAggregateIncomeRatePerSecond(
                nextTiers,
                s.baseballTiers,
                globalRevenueMultiplier(s.legacy.permanentUpgrades),
                s.baseballCostAnchorMultiplier,
              ),
          )
          // Shared by both return shapes below — a purchase can complete a
          // DAILY/WEEKLY objective just as it can a rotating one (training
          // levels are one of the stats they track), so the periodic slots
          // and any Legacy Points they granted must be written here too.
          const objectiveFields = {
            currencies: { revenue: resolved.revenue },
            objectives: resolved.objectives,
            dailyObjective: resolved.daily,
            weeklyObjective: resolved.weekly,
            legacy: withLegacyPoints(s.legacy, s.legacy.legacyPoints + resolved.legacyPointsReward),
          }
          if (crossedMilestones.length === 0) {
            return { ...objectiveFields, tiers: nextTiers }
          }
          let nextId = s.notifications.length ? Math.max(...s.notifications.map((n) => n.id)) + 1 : 1
          const newNotifications = crossedMilestones.map(() => ({
            id: nextId++,
            message: `${SOCCER_VENTURE_TIERS[tierIndex].name} Revenue 2x!`,
          }))
          return {
            ...objectiveFields,
            tiers: nextTiers,
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

        set((s) => {
          const nextTiers = s.tiers.map((t, i) => (i === tierIndex ? { ...t, unlocked: true } : t))
          // A purchase moves a stat objectives track (tier levels / unlocked
          // count), so objectives resolve here too — not only on ticks.
          const resolved = resolveObjectivesForState(
            s.objectives,
            s.dailyObjective,
            s.weeklyObjective,
            nextTiers,
            s.baseballTiers,
            s.lifetimeStats,
            s.legacy.prestigeCount,
            s.currencies.revenue - cost,
            () =>
              currentAggregateIncomeRatePerSecond(
                nextTiers,
                s.baseballTiers,
                globalRevenueMultiplier(s.legacy.permanentUpgrades),
                s.baseballCostAnchorMultiplier,
              ),
          )
          return {
            currencies: { revenue: resolved.revenue },
            tiers: nextTiers,
            objectives: resolved.objectives,
            dailyObjective: resolved.daily,
            weeklyObjective: resolved.weekly,
            legacy: withLegacyPoints(s.legacy, s.legacy.legacyPoints + resolved.legacyPointsReward),
          }
        })
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

            // Objectives share this exact evaluation point with achievements
            // (see resolveObjectivesForState) — same post-update state, same
            // lazy income-rate thunk, same atomic set(). `granted.revenue`
            // is threaded in as the base so both systems' rewards stack
            // within one frame rather than one clobbering the other.
            const objectiveResult = resolveObjectivesForState(
              s.objectives,
              s.dailyObjective,
              s.weeklyObjective,
              s.tiers,
              updatedTiers,
              { ...s.lifetimeStats, totalWins, baseballWins },
              s.legacy.prestigeCount,
              granted.revenue,
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
              currencies: { revenue: objectiveResult.revenue },
              lifetimeStats: { ...s.lifetimeStats, totalWins, baseballWins },
              achievements: granted.grantedCount ? { earnedIds: granted.earnedIds } : s.achievements,
              legacy: withLegacyPoints(s.legacy, granted.legacyPoints + objectiveResult.legacyPointsReward),
              objectives: objectiveResult.objectives,
              dailyObjective: objectiveResult.daily,
              weeklyObjective: objectiveResult.weekly,
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

            // Objectives share this exact evaluation point with achievements
            // (see resolveObjectivesForState) — same post-update state, same
            // lazy income-rate thunk, same atomic set(). `granted.revenue`
            // is threaded in as the base so both systems' rewards stack
            // within one frame rather than one clobbering the other.
            const objectiveResult = resolveObjectivesForState(
              s.objectives,
              s.dailyObjective,
              s.weeklyObjective,
              s.tiers,
              updatedTiers,
              s.lifetimeStats,
              s.legacy.prestigeCount,
              granted.revenue,
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
              currencies: { revenue: objectiveResult.revenue },
              achievements: granted.grantedCount ? { earnedIds: granted.earnedIds } : s.achievements,
              legacy: withLegacyPoints(s.legacy, granted.legacyPoints + objectiveResult.legacyPointsReward),
              objectives: objectiveResult.objectives,
              dailyObjective: objectiveResult.daily,
              weeklyObjective: objectiveResult.weekly,
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
          const nextBaseballTiers = s.baseballTiers.map((t, i) =>
            i === tierIndex ? { ...t, level: nextLevel } : t,
          )
          // A purchase moves a stat objectives track (tier levels / unlocked
          // count), so objectives resolve here too — not only on ticks.
          const resolved = resolveObjectivesForState(
            s.objectives,
            s.dailyObjective,
            s.weeklyObjective,
            s.tiers,
            nextBaseballTiers,
            s.lifetimeStats,
            s.legacy.prestigeCount,
            s.currencies.revenue - cost,
            () =>
              currentAggregateIncomeRatePerSecond(
                s.tiers,
                nextBaseballTiers,
                globalRevenueMultiplier(s.legacy.permanentUpgrades),
                s.baseballCostAnchorMultiplier,
              ),
          )
          // See upgradeTier's identical block — a purchase can complete a
          // periodic objective too, so both slots are written here as well.
          const objectiveFields = {
            currencies: { revenue: resolved.revenue },
            objectives: resolved.objectives,
            dailyObjective: resolved.daily,
            weeklyObjective: resolved.weekly,
            legacy: withLegacyPoints(s.legacy, s.legacy.legacyPoints + resolved.legacyPointsReward),
          }
          if (crossedMilestones.length === 0) {
            return { ...objectiveFields, baseballTiers: nextBaseballTiers }
          }
          let nextId = s.notifications.length ? Math.max(...s.notifications.map((n) => n.id)) + 1 : 1
          const newNotifications = crossedMilestones.map(() => ({
            id: nextId++,
            message: `${config.name} Revenue 2x!`,
          }))
          return {
            ...objectiveFields,
            baseballTiers: nextBaseballTiers,
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

        set((s) => {
          const nextBaseballTiers = s.baseballTiers.map((t, i) =>
            i === tierIndex ? { ...t, unlocked: true } : t,
          )
          // A purchase moves a stat objectives track (tier levels / unlocked
          // count), so objectives resolve here too — not only on ticks.
          const resolved = resolveObjectivesForState(
            s.objectives,
            s.dailyObjective,
            s.weeklyObjective,
            s.tiers,
            nextBaseballTiers,
            s.lifetimeStats,
            s.legacy.prestigeCount,
            s.currencies.revenue - cost,
            () =>
              currentAggregateIncomeRatePerSecond(
                s.tiers,
                nextBaseballTiers,
                globalRevenueMultiplier(s.legacy.permanentUpgrades),
                s.baseballCostAnchorMultiplier,
              ),
          )
          return {
            currencies: { revenue: resolved.revenue },
            baseballTiers: nextBaseballTiers,
            objectives: resolved.objectives,
            dailyObjective: resolved.daily,
            weeklyObjective: resolved.weekly,
            legacy: withLegacyPoints(s.legacy, s.legacy.legacyPoints + resolved.legacyPointsReward),
          }
        })
      },

      // The wall-clock half of the periodic system — see the interface
      // declaration above for why a timer is needed at all alongside the
      // tick/purchase evaluation.
      //
      // Reads once via get(), bails when nothing changed, and only then
      // writes. That early bail is what keeps a 30-second heartbeat free:
      // without it every wake-up would produce a new state object and, via
      // the persist middleware, a fresh localStorage write forever. There is
      // no await between the read and the write, so no other action can
      // interleave — the state this computes against is the state it writes.
      refreshPeriodicObjectives: () => {
        const s = get()
        const stats = selectObjectiveStats(s.tiers, s.baseballTiers, s.lifetimeStats, s.legacy.prestigeCount)
        const resolved = resolvePeriodicObjectivePair(
          s.dailyObjective,
          s.weeklyObjective,
          stats,
          Date.now(),
          () =>
            currentAggregateIncomeRatePerSecond(
              s.tiers,
              s.baseballTiers,
              globalRevenueMultiplier(s.legacy.permanentUpgrades),
              s.baseballCostAnchorMultiplier,
            ),
        )
        if (!resolved.changed) return

        set((st) => ({
          dailyObjective: resolved.daily,
          weeklyObjective: resolved.weekly,
          currencies: resolved.revenueReward
            ? { revenue: st.currencies.revenue + resolved.revenueReward }
            : st.currencies,
          legacy: withLegacyPoints(st.legacy, st.legacy.legacyPoints + resolved.legacyPointsReward),
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
          // A fresh set, baselined against fresh-game state — same helper
          // the store's own initial state uses, so a wiped save is
          // indistinguishable from a brand-new one here too.
          objectives: createInitialObjectives(freshLegacy.permanentUpgrades),
          // Both periodic slots are wiped and re-anchored to now as well —
          // this button's whole point is a state indistinguishable from a
          // brand-new player's, which includes their day and week starting
          // fresh rather than inheriting the old save's boundaries (or,
          // worse, an already-claimed weekly).
          dailyObjective: createInitialPeriodicObjective('daily', freshLegacy.permanentUpgrades),
          weeklyObjective: createInitialPeriodicObjective('weekly', freshLegacy.permanentUpgrades),
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
          // Computed once and shared by every re-baselining consumer below
          // (the rotating array and both periodic slots), so the three can
          // never disagree about what the post-reset economy looks like.
          const postResetAnchor = computeBaseballCostAnchorMultiplier(
            nextTiers,
            nextBaseballTiers,
            nextLegacy.permanentUpgrades,
          )
          const postResetStats = selectObjectiveStats(
            nextTiers,
            nextBaseballTiers,
            s.lifetimeStats,
            nextLegacy.prestigeCount,
          )
          const postResetIncomeRate = currentAggregateIncomeRatePerSecond(
            nextTiers,
            nextBaseballTiers,
            globalRevenueMultiplier(nextLegacy.permanentUpgrades),
            postResetAnchor,
          )
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
            baseballCostAnchorMultiplier: postResetAnchor,
            currencies: { revenue: startingRevenue(nextLegacy.permanentUpgrades) },
            // Re-baseline the RUN-SCOPED objectives against the post-reset
            // state, and leave lifetime-scoped ones (the win counters, which
            // survive a prestige by design) exactly as they are.
            //
            // Without this, an in-flight run-scoped objective would be left
            // holding a baseline captured from the pre-reset economy — e.g.
            // "improve training 20 more times" baselined at 40 total levels,
            // while the post-reset state has 22 — making its progress clamp
            // at 0 forever, permanently unachievable. Re-baselining is the
            // fix; the clamp in objectiveProgress is only a render-time
            // safety net. Targets are deliberately NOT re-resolved: the
            // player keeps the objective they were given, just measured from
            // the new starting line.
            objectives: rebaselineRunScopedObjectives(s.objectives, postResetStats, postResetIncomeRate),
            // The Daily and Weekly slots deliberately SURVIVE a prestige
            // rather than resetting with it: they are commitments to a
            // period of real time, not to a run, and a player who prestiges
            // on day 3 of a weekly should not lose the week (nor be able to
            // reset a weekly they've already claimed by prestiging, which is
            // what makes this the safe direction as well as the kind one).
            // Only their baselines move, and only for run-scoped stats — the
            // exact same correction the rotating array gets, and for the
            // same reason: a prestige zeroes tier state, so a stale baseline
            // would leave the objective permanently unachievable.
            dailyObjective: rebaselinePeriodicObjective(
              'daily',
              s.dailyObjective,
              postResetStats,
              postResetIncomeRate,
            ),
            weeklyObjective: rebaselinePeriodicObjective(
              'weekly',
              s.weeklyObjective,
              postResetStats,
              postResetIncomeRate,
            ),
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
        objectives: state.objectives,
        dailyObjective: state.dailyObjective,
        weeklyObjective: state.weeklyObjective,
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
        // `objectives` gets the same never-trust-the-shape treatment, and
        // for the same "a save already AT the current version skips
        // migrate() entirely" reason — plus the repairs that need a live
        // stats snapshot (dropping stale baselines, topping back up to a
        // full set). Runs AFTER the tiers/lifetimeStats guards above so it
        // measures against the already-repaired state.
        merged.objectives = ensureObjectives(
          merged.objectives,
          merged.tiers,
          merged.baseballTiers,
          merged.lifetimeStats,
          merged.legacy?.prestigeCount ?? 0,
          merged.legacy?.permanentUpgrades ?? createInitialPermanentUpgrades(),
          merged.baseballCostAnchorMultiplier,
          currentState.objectives,
        )
        // Both periodic slots get the same treatment, for the same
        // skips-migrate()-at-the-current-version reason — and with rather
        // more at stake for the weekly one, since a slot whose boundary
        // fields were corrupted into unusability would otherwise either
        // crash the panel or (if it defaulted permissively) hand out a fresh
        // Legacy-Point-bearing objective on every single load. Falling back
        // to `currentState`'s fresh slot anchors a repaired boundary to NOW,
        // so a repair always costs a full period rather than granting one.
        merged.dailyObjective = ensurePeriodicObjective(
          'daily',
          merged.dailyObjective,
          merged.tiers,
          merged.baseballTiers,
          merged.lifetimeStats,
          merged.legacy?.prestigeCount ?? 0,
          merged.legacy?.permanentUpgrades ?? createInitialPermanentUpgrades(),
          merged.baseballCostAnchorMultiplier,
          currentState.dailyObjective,
        )
        merged.weeklyObjective = ensurePeriodicObjective(
          'weekly',
          merged.weeklyObjective,
          merged.tiers,
          merged.baseballTiers,
          merged.lifetimeStats,
          merged.legacy?.prestigeCount ?? 0,
          merged.legacy?.permanentUpgrades ?? createInitialPermanentUpgrades(),
          merged.baseballCostAnchorMultiplier,
          currentState.weeklyObjective,
        )
        return merged
      },
    },
  ),
)
