// ============================================================
// src/engine/objectives.ts
// Config-driven short-term "Objectives" system — a small rotating set of
// 2-3 goals shown on the Hub. Sport-agnostic in exactly the same way
// achievements.ts is: this file only ever consumes a generic stats record
// (Record<string, number>) supplied by the store, never imports from
// src/sports/** (economy.ts, its one import, is itself sport-agnostic — it
// is where this project's currency math is required to live), and has zero
// special-casing for any single stat. Adding a
// new objective TYPE is purely an OBJECTIVE_POOL entry (plus, if it tracks a
// genuinely new stat, one OBJECTIVE_STAT_LABELS entry and the store
// supplying that key in its record) — see CLAUDE.md's "Objectives" section.
//
// RELATIONSHIP TO ACHIEVEMENTS: deliberately a SEPARATE system, not more
// achievement lines. Achievements are permanent, one-time, lifetime
// milestones with fixed absolute thresholds; objectives are repeatable,
// short-horizon, and measured as a DELTA from the moment they were assigned
// (see ActiveObjective.baseline), so the same objective can be drawn again
// later and still mean something. They share the reward MATH
// (economy.ts's scaledRevenueReward) but nothing else.
// ============================================================

import { scaledRevenueReward } from './economy'

/** Display label per objective `statTracked` key. Same `as const` +
 *  derived-key-type pattern STAT_LABELS/StatKey use in achievements.ts, and
 *  for the same reason: a stringly-typed key would let a typo in a pool
 *  entry silently produce an objective that can never progress. */
export const OBJECTIVE_STAT_LABELS = {
  totalWins: 'Wins (any sport)',
  soccerWins: 'Soccer wins',
  baseballWins: 'Baseball wins',
  franchiseEarnings: 'Revenue earned',
  totalTierLevels: 'Training levels',
  tiersUnlocked: 'Tiers unlocked',
  /** Baseball's unlocked-tier count on its own, separate from the combined
   *  `tiersUnlocked`. Not currently the target of any objective — it exists
   *  as an ELIGIBILITY signal (see ObjectiveConfig.requiresStatPositive):
   *  a player who has never bought into baseball cannot win a baseball
   *  match, so baseball-specific objectives must not be drawn for them. */
  baseballTiersUnlocked: 'Baseball tiers unlocked',
} as const

export type ObjectiveStatKey = keyof typeof OBJECTIVE_STAT_LABELS

/**
 * Whether a stat keeps climbing forever, or restarts when the player
 * prestiges.
 *
 * This exists because objectives measure a DELTA from a captured baseline,
 * and a prestige (`resetForLegacy`) zeroes every tier's level/unlocked
 * status/cumulativeRevenue. Without this distinction, a run-scoped
 * objective assigned before a prestige would be left with a baseline ABOVE
 * the post-reset value — permanently unreachable (progress would clamp at 0
 * forever). The store re-baselines exactly the `run`-scoped objectives on
 * prestige, and deliberately leaves `lifetime` ones alone so a player
 * doesn't lose genuine in-flight progress on stats that survive a prestige
 * by design (wins are lifetime accomplishments — see CLAUDE.md).
 */
export type ObjectiveStatScope = 'lifetime' | 'run'

export const OBJECTIVE_STAT_SCOPES: Record<ObjectiveStatKey, ObjectiveStatScope> = {
  totalWins: 'lifetime',
  soccerWins: 'lifetime',
  baseballWins: 'lifetime',
  // All three below are derived from tier state, which resetForLegacy wipes.
  franchiseEarnings: 'run',
  totalTierLevels: 'run',
  tiersUnlocked: 'run',
  baseballTiersUnlocked: 'run',
}

/**
 * How an objective's target number is produced when it is ASSIGNED.
 *
 * - 'fixed': the literal count in `targetAmount` (e.g. win 5 more matches).
 *   Correct for count-like stats, whose difficulty doesn't change as the
 *   economy inflates — a win is a win at any tier.
 * - 'incomeRateSeconds': `targetAmount` is a number of SECONDS, resolved at
 *   assignment time against the player's current aggregate income rate.
 *   Required for Revenue targets specifically: this economy spans many
 *   orders of magnitude (see the income-rate-anchored-costs amendment), so
 *   any fixed Revenue number would be an impossible wall early and
 *   instantly-complete noise later. Expressing it as "about a minute of
 *   your current income" keeps one pool entry meaningful at every stage.
 */
export type ObjectiveTargetKind = 'fixed' | 'incomeRateSeconds'

export interface ObjectiveConfig {
  id: string
  /** Key into the stats record the store supplies (see the store's
   *  `objectiveStats`). */
  statTracked: ObjectiveStatKey
  targetKind: ObjectiveTargetKind
  /** A literal count, or a number of seconds — see ObjectiveTargetKind. */
  targetAmount: number
  /**
   * Legacy Points granted on completion, ON TOP of the Revenue reward.
   *
   * ONLY the weekly pool ever sets this (always to the single shared
   * WEEKLY_LEGACY_POINT_REWARD constant — see its doc comment for the
   * calibration and for why one fixed value rather than a per-entry one).
   * Every rotating and daily entry leaves it undefined, and the rotating
   * grant path in the store never reads it at all, so a Legacy Point can
   * only ever be emitted by the weekly path.
   *
   * That is enforced structurally, not by convention: config lookup is
   * POOL-SCOPED (`objectiveConfigById` searches only the rotating pool;
   * `periodicObjectiveConfigById` only that kind's pool), so a hand-edited
   * save that drops a weekly config id into the fast-rotating `objectives`
   * array gets it REJECTED as unknown rather than farming Legacy Points on
   * a ~minute cycle.
   */
  rewardLegacyPoints?: number
  /** Renders the player-facing text. Takes the RESOLVED target so an
   *  income-scaled objective can state its real number. A function rather
   *  than a format string so a future objective can phrase itself however
   *  it needs (pluralisation, units) without a mini template language. */
  describe: (resolvedTarget: number) => string
  /** Reward, in seconds of the player's aggregate income rate at the moment
   *  of COMPLETION — granted via economy.ts's shared scaledRevenueReward,
   *  the identical function achievements' `scaledRevenue` rewards use. */
  rewardIncomeRateSeconds: number
  /** Floor for that reward, for the genuinely-zero-income case (no manager
   *  hired anywhere — see scaledRevenueReward's doc comment). */
  rewardMinAmount: number
  /**
   * Optional eligibility gate: this objective is only ever DRAWN while the
   * named stat is greater than zero.
   *
   * Exists because a shared cross-sport pool can otherwise hand a player an
   * objective they are structurally incapable of progressing — concretely,
   * "win 10 more baseball matches" for someone who has never unlocked a
   * single baseball tier. That objective could never complete, so it would
   * occupy one of only three slots indefinitely. Simulation across game
   * states surfaced exactly this case (baseball wins were unreachable in
   * the early-game state), which is why this gate exists rather than being
   * speculative. Checked at DRAW time only — an objective already in flight
   * is never revoked, so a prestige can't yank a goal out from under a
   * player mid-progress.
   */
  requiresStatPositive?: ObjectiveStatKey
}

/**
 * THE OBJECTIVE POOL — one shared pool spanning BOTH sports, deliberately
 * not per-sport queues, so a player is nudged across their whole franchise
 * rather than being handed parallel to-do lists.
 *
 * Variety reasoning (targets and rewards are simulation-calibrated — see
 * CLAUDE.md's "Objectives" section for the full derivation):
 *  - Two cross-sport win objectives at different sizes (a quick one and a
 *    longer one), so the active set can mix a near-term and a stretch goal.
 *  - One per-sport win objective each, which nudge toward whichever sport
 *    the player has been neglecting (they progress only from that sport).
 *  - Two training objectives at different sizes — these reward the
 *    "spend on upgrades" loop rather than the passive-idle loop. The larger
 *    one is 10, not 20: simulation showed 20 levels costs ~28 MINUTES at the
 *    median (training cost grows exponentially), far outside the range every
 *    other entry occupies and no longer a "short-term" goal at all.
 *  - One unlock objective, the natural "push your frontier" goal.
 *  - One income-scaled Revenue objective, which stays meaningful at every
 *    economic scale (see ObjectiveTargetKind).
 *
 * `rewardIncomeRateSeconds` is roughly proportional to each objective's
 * simulated completion time, so a longer objective genuinely pays more —
 * the calibration the task asked for, rather than round numbers.
 */
export const OBJECTIVE_POOL: ObjectiveConfig[] = [
  {
    id: 'wins-any-5',
    statTracked: 'totalWins',
    targetKind: 'fixed',
    targetAmount: 5,
    describe: (n) => `Win ${n} more matches (any sport)`,
    rewardIncomeRateSeconds: 4,
    rewardMinAmount: 60,
  },
  {
    id: 'wins-any-20',
    statTracked: 'totalWins',
    targetKind: 'fixed',
    targetAmount: 20,
    describe: (n) => `Win ${n} more matches (any sport)`,
    rewardIncomeRateSeconds: 16,
    rewardMinAmount: 240,
  },
  {
    id: 'wins-soccer-10',
    statTracked: 'soccerWins',
    targetKind: 'fixed',
    targetAmount: 10,
    describe: (n) => `Win ${n} more soccer matches`,
    rewardIncomeRateSeconds: 20,
    rewardMinAmount: 300,
  },
  {
    id: 'wins-baseball-10',
    statTracked: 'baseballWins',
    targetKind: 'fixed',
    targetAmount: 10,
    describe: (n) => `Win ${n} more baseball matches`,
    rewardIncomeRateSeconds: 8,
    rewardMinAmount: 120,
    // Undrawable until the player actually owns a baseball tier — otherwise
    // this can never progress. See requiresStatPositive's doc comment.
    requiresStatPositive: 'baseballTiersUnlocked',
  },
  {
    id: 'training-5',
    statTracked: 'totalTierLevels',
    targetKind: 'fixed',
    targetAmount: 5,
    describe: (n) => `Improve training ${n} times (any tier)`,
    rewardIncomeRateSeconds: 3,
    rewardMinAmount: 45,
  },
  {
    id: 'training-10',
    statTracked: 'totalTierLevels',
    targetKind: 'fixed',
    targetAmount: 10,
    describe: (n) => `Improve training ${n} times (any tier)`,
    rewardIncomeRateSeconds: 12,
    rewardMinAmount: 180,
  },
  {
    id: 'unlock-1',
    statTracked: 'tiersUnlocked',
    targetKind: 'fixed',
    targetAmount: 1,
    describe: () => 'Unlock your next tier (either sport)',
    rewardIncomeRateSeconds: 3,
    rewardMinAmount: 45,
  },
  {
    id: 'earn-revenue-90s',
    statTracked: 'franchiseEarnings',
    targetKind: 'incomeRateSeconds',
    targetAmount: 90,
    describe: (n) => `Earn ${n.toLocaleString()} more Revenue`,
    rewardIncomeRateSeconds: 7,
    rewardMinAmount: 105,
  },
]

/** How many objectives are active at once. The task's "always exactly 2-3":
 *  the store tops up to TARGET whenever there is room, and the pool is
 *  comfortably larger than TARGET so a top-up can always find a candidate
 *  whose stat isn't already in play. */
export const ACTIVE_OBJECTIVE_TARGET = 3

/**
 * The minimum income rate an income-scaled TARGET is sized against.
 *
 * `tierIncomeRatePerSecond` returns exactly 0 for an unmanaged tier, so the
 * aggregate rate is genuinely 0 for every fresh save, every
 * `resetProgress()`, every post-prestige run before the first manager is
 * re-hired, and the whole pre-manager early game. Sizing the target off that
 * raw 0 collapsed `earn-revenue-90s` to a target of 1 ("Earn 1 more
 * Revenue") — trivially complete on the first click, while
 * `scaledRevenueReward` still paid its full 105 floor. That single click
 * bought the 100-cost first Improve Training outright, against the ~25-click
 * onboarding beat the economy is deliberately tuned to.
 *
 * 15 is not arbitrary: every pool entry's `rewardMinAmount` is exactly
 * `15 x rewardIncomeRateSeconds`, so the reward floor already implicitly
 * assumes a rate of 15/sec. Flooring the TARGET rate at the same 15 makes
 * the reward-to-target ratio hold by construction at zero income instead of
 * diverging (it was 0.078 at every real rate and 105.0 at rate 0), and puts
 * the zero-income Revenue target (1,350) in line with its siblings at that
 * same state. An adversarial review caught the divergence.
 */
export const OBJECTIVE_FLOOR_INCOME_RATE = 15

/**
 * One assigned objective. `baseline` and `target` are both captured AT
 * ASSIGNMENT and then frozen:
 *  - `baseline` is what makes progress a delta ("win 5 MORE") without any
 *    notion of a session, which this always-persistent, no-login game has no
 *    clean way to define.
 *  - `target` is stored rather than re-read from config so an
 *    income-scaled objective can't silently move its own goalposts as the
 *    player's economy grows mid-objective, and so an in-flight objective
 *    survives a future rebalance of the pool's numbers unchanged.
 */
export interface ActiveObjective {
  configId: string
  baseline: number
  target: number
}

export function objectiveConfigById(configId: string): ObjectiveConfig | undefined {
  return OBJECTIVE_POOL.find((o) => o.id === configId)
}

export interface ObjectiveProgress {
  config: ObjectiveConfig
  current: number
  target: number
  /** 0-100, clamped. */
  percent: number
  complete: boolean
  description: string
}

/**
 * Progress on one active objective, given the current stats record.
 *
 * `current` is clamped at 0 because a `run`-scoped stat can legitimately
 * fall below its baseline (a prestige zeroes tier state). The store
 * re-baselines run-scoped objectives on prestige so this is a transient
 * safety net rather than the mechanism, but clamping means a mid-transition
 * render can never show a negative count or a backwards bar.
 */
export function objectiveProgress(
  active: ActiveObjective,
  stats: Record<string, number>,
): ObjectiveProgress | null {
  const config = objectiveConfigById(active.configId)
  if (!config) return null
  return progressForConfig(config, active, stats)
}

/**
 * The progress computation itself, given an ALREADY-RESOLVED config.
 *
 * Split out from `objectiveProgress` above so the daily/weekly pools can
 * share the exact same math while keeping config lookup POOL-SCOPED (see
 * ObjectiveConfig.rewardLegacyPoints for why that scoping is a real
 * safeguard, not just tidiness). Every objective in the game — rotating,
 * daily, weekly — measures progress through this one function, so a player
 * can never see a percentage the store would judge differently.
 */
function progressForConfig(
  config: ObjectiveConfig,
  active: ActiveObjective,
  stats: Record<string, number>,
): ObjectiveProgress {
  const raw = (stats[config.statTracked] ?? 0) - active.baseline
  const current = Math.max(0, Number.isFinite(raw) ? raw : 0)
  const target = active.target > 0 ? active.target : 1
  return {
    config,
    current,
    target,
    percent: Math.min(100, Math.round((current / target) * 100)),
    complete: current >= target,
    description: config.describe(target),
  }
}

/**
 * Resolves a pool entry's concrete target at assignment time — see
 * ObjectiveTargetKind. An income-scaled target floors at 1 so a
 * zero-income player is never handed an already-complete (target 0)
 * objective.
 */
export function resolveObjectiveTarget(
  config: ObjectiveConfig,
  incomeRatePerSecond: number,
): number {
  if (config.targetKind === 'fixed') return Math.max(1, Math.round(config.targetAmount))
  const rate = Number.isFinite(incomeRatePerSecond) ? Math.max(0, incomeRatePerSecond) : 0
  // Floor the RATE (see OBJECTIVE_FLOOR_INCOME_RATE), not the resulting
  // target — flooring the target at 1 prevented an auto-complete-at-0 but
  // still produced a degenerate "Earn 1 more Revenue".
  return Math.max(1, Math.round(config.targetAmount * Math.max(rate, OBJECTIVE_FLOOR_INCOME_RATE)))
}

/**
 * Picks the next objective to assign, excluding any pool entry that is
 * ineligible for this player (see requiresStatPositive) or whose
 * `statTracked` is already in play. That exclusion (rather than merely
 * excluding the same id) is what stops the active set from showing e.g.
 * "win 5 more matches" and "win 20 more matches" simultaneously, which
 * would read as one duplicated goal. Deliberately simple, per the task —
 * no weighting or anti-repeat history.
 *
 * Returns null when every eligible stat is already represented — the store
 * treats that as "keep what we have" (2 active is spec-compliant), never as
 * an error.
 *
 * `random` is injected so tests can make draws deterministic; the store
 * passes Math.random.
 */
export function drawObjective(
  activeConfigIds: readonly string[],
  stats: Record<string, number>,
  random: () => number = Math.random,
  excludeConfigIds: readonly string[] = [],
): ObjectiveConfig | null {
  const activeConfigs = activeConfigIds
    .map(objectiveConfigById)
    .filter((c): c is ObjectiveConfig => Boolean(c))
  const excludedConfigs = excludeConfigIds
    .map(objectiveConfigById)
    .filter((c): c is ObjectiveConfig => Boolean(c))
  // Both the still-active objectives AND anything explicitly excluded (in
  // practice: whatever just completed this tick) contribute their stat to
  // the "don't draw this again right now" set.
  const activeStats = new Set([...activeConfigs, ...excludedConfigs].map((c) => c.statTracked))

  // Eligibility is applied FIRST and is never relaxed by the fallback below:
  // an ineligible objective is one the player structurally cannot progress,
  // so drawing it is always wrong, whereas the same-stat exclusion is only a
  // presentation preference.
  const eligible = OBJECTIVE_POOL.filter(
    (c) => !c.requiresStatPositive || (stats[c.requiresStatPositive] ?? 0) > 0,
  )

  // No id-only fallback: returning a same-stat sibling here would defeat the
  // exclusion this function exists to enforce. Running with 2 active
  // objectives is explicitly spec-compliant ("always 2-3") and self-corrects
  // on the next completion, so `null` is the right answer when every
  // eligible stat is already represented. An adversarial review caught that
  // the old fallback was reachable in normal play (a soccer-only player has
  // `wins-baseball-10` gated out, leaving 5 eligible stats for 3 slots) —
  // not merely "if the pool ever shrinks", as the comment used to claim.
  const candidates = eligible.filter((c) => !activeStats.has(c.statTracked))
  if (candidates.length === 0) return null

  const index = Math.min(candidates.length - 1, Math.floor(random() * candidates.length))
  return candidates[index]
}

/**
 * Tops the active list up to ACTIVE_OBJECTIVE_TARGET, assigning each new
 * objective its baseline (the stat's value right now) and resolved target.
 * Pure: returns a new array, never mutates its input. Used for the very
 * first assignment (a fresh save and the schema migration), for the refill
 * after a completion, and as a self-heal if a save somehow arrives with too
 * few (e.g. a hand-edited or partially-corrupted objectives array).
 *
 * `excludeConfigIds` is how a refill avoids immediately re-handing the
 * player the objective they just finished (the store passes the
 * just-completed ids). Without it, "Improve training 5 times" can complete
 * and reappear in the very same frame — technically valid, since it gets a
 * fresh baseline, but it reads as though nothing happened.
 */
export function fillObjectives(
  existing: readonly ActiveObjective[],
  stats: Record<string, number>,
  incomeRatePerSecond: number,
  random: () => number = Math.random,
  excludeConfigIds: readonly string[] = [],
): ActiveObjective[] {
  const result = [...existing]
  let guard = 0
  while (result.length < ACTIVE_OBJECTIVE_TARGET && guard++ < OBJECTIVE_POOL.length + 1) {
    const config = drawObjective(
      result.map((a) => a.configId),
      stats,
      random,
      excludeConfigIds,
    )
    if (!config) break
    const statValue = stats[config.statTracked] ?? 0
    result.push({
      configId: config.id,
      baseline: Number.isFinite(statValue) ? statValue : 0,
      target: resolveObjectiveTarget(config, incomeRatePerSecond),
    })
  }
  return result
}

/**
 * Sanitizes a persisted `objectives` value of UNKNOWN shape into a valid
 * array — same never-trust-persisted-shape posture the store already
 * applies to tiers/lifetimeStats/achievements (see CLAUDE.md's repeated
 * corrupted-save findings). Drops any entry that isn't a well-formed object
 * referencing a pool id that still exists, so removing a pool entry in a
 * future rebalance can't leave a save holding an unrenderable objective.
 * Callers top the result back up via fillObjectives.
 */
export function sanitizeObjectives(value: unknown): ActiveObjective[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const result: ActiveObjective[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const { configId, baseline, target } = entry as Partial<ActiveObjective>
    if (typeof configId !== 'string' || seen.has(configId)) continue
    if (!objectiveConfigById(configId)) continue
    if (!Number.isFinite(baseline) || !Number.isFinite(target)) continue
    seen.add(configId)
    result.push({ configId, baseline: baseline as number, target: Math.max(1, target as number) })
    if (result.length >= ACTIVE_OBJECTIVE_TARGET) break
  }
  return result
}

// ============================================================
// DAILY / WEEKLY OBJECTIVES
//
// A second and third objective TIER layered on the rotating pool above,
// shown as their own sections inside the same Hub Objectives card. They
// reuse the ObjectiveConfig shape, the ActiveObjective baseline-delta
// mechanism, the progress math, and the shared reward machinery
// (economy.ts's scaledRevenueReward) — literally the same code paths, not
// parallel copies. What differs is deliberately only three things:
//
//  1. EXACTLY ONE active at a time per tier (not 2-3), with its own
//     RESET BOUNDARY rather than instant rotation on completion.
//  2. TARGETS SCALED FOR A PERIOD OF PLAY, not a quick immediate goal —
//     see DAILY_OBJECTIVE_POOL / WEEKLY_OBJECTIVE_POOL for the simulated
//     calibration behind every number.
//  3. CAPPED COMPLETION: on completion the objective is rewarded once and
//     then sits in a "completed — resets in <time>" state. It does NOT
//     redraw until its own boundary passes, which is what makes a daily a
//     daily rather than an unusually large rotating objective.
//
// A NOTE ON TIME, since this is the first date/clock logic in the project:
// every function below takes `nowMs` explicitly and reads no ambient clock
// of its own. The store passes Date.now(); tests pass whatever instant they
// want. That is what makes midnight/DST/7-day-boundary behaviour directly
// testable rather than something that can only be observed by waiting.
// ============================================================

export type PeriodicObjectiveKind = 'daily' | 'weekly'

/** The weekly window, as a ROLLING 7 days from the last reset — deliberately
 *  not aligned to a specific weekday. A calendar week would need a
 *  day-of-week choice, would interact with timezone travel, and would hand
 *  a player who first plays on a Saturday a one-hour "week". A rolling
 *  window has none of those edge cases: the rule is simply "7 days since
 *  your last weekly reset, whenever that was". */
export const WEEKLY_PERIOD_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Legacy Points granted by ANY completed weekly objective.
 *
 * ── WHY A FIXED NUMBER, AND WHY 5 ──
 * Deliberately NOT derived from `calculateLegacyPoints` (prestige.ts): that
 * formula converts a run's sacrificed earnings into points, and a weekly
 * objective sacrifices nothing. Reusing it would also make the reward scale
 * with the player's economy, which is precisely the wrong direction — Legacy
 * Point SCARCITY is what keeps prestige meaningful, so this reward has to
 * shrink in relative terms as a player grows, not keep pace with them.
 *
 * Calibrated against what prestige actually pays, measured with the real
 * `calculateLegacyPoints` over simulated franchise earnings:
 *   300k earnings -> 54 LP | 700k -> 83 LP | 2M -> 141 LP | 47M -> 685 LP
 * (the 47M/685 figure is a real, measured save — see CLAUDE.md). A greedy
 * simulated run reaches prestige eligibility in ~10.5 minutes of app-open
 * play, so an engaged player can realistically bank hundreds to a couple of
 * thousand Legacy Points a week from prestige alone.
 *
 * Against that, 5 LP/week is:
 *   - ~6% of a single EARLY prestige (83 LP), ~3.5% of a mid one (141 LP),
 *     and well under 1% of a developed one (685 LP) — modest at every stage,
 *     and automatically MORE modest the further a player gets;
 *   - ~0.25% of an engaged player's weekly prestige income;
 *   - never a substitute for prestiging: at 5/week it takes 4 weeks to
 *     afford Revenue Boost level 1 (20 LP) from weeklies alone.
 * It is still a real reward at the scale that matters most — a player who
 * prestiges rarely reaches Head Start Capital (15 LP, the cheapest permanent
 * upgrade) after three weeks. That is the intended shape: a slow, steady
 * trickle that respects the currency rather than inflating it.
 *
 * ONE shared constant rather than a per-entry amount, so the guarantee this
 * system rests on is a single checkable fact: **at most 5 Legacy Points can
 * be granted per 7-day window, and only by the weekly path.**
 */
export const WEEKLY_LEGACY_POINT_REWARD = 5

/**
 * DAILY POOL — one drawn per calendar day.
 *
 * ── TARGET CALIBRATION (simulated against the real engine) ──
 * Crucially, this game has NO offline-progress system: `useMatchTicker`'s
 * intervals only run while the app is open, so "a full day's play" means the
 * time a player actually spends IN the app that day — not 24 hours of wall
 * clock. Targets are therefore sized to a realistic day's session time, not
 * to a day of idle accrual.
 *
 * Each candidate target was measured across four representative game states
 * (early / early-mid / mid / late — the same multi-state method the rotating
 * pool's own calibration used, under the same hyper-engaged assumption of a
 * sustained 1 manual click/sec on the frontier tier plus every managed
 * tier's real auto-tick pace). Medians landed at:
 *   wins-any 100 -> 13.1 min | wins-soccer 60 -> 17.5 min
 *   wins-baseball 60 -> 10.0 min | training 20 -> 10.3 min
 *   earn-revenue 1800s -> 13.9 min
 * i.e. a tight ~10-18 minute cluster — roughly 10-20x a rotating objective
 * (29-246 seconds), which is the "a day's goal, not a two-minute errand"
 * step-up this tier exists for. Real, less relentlessly-clicked play takes
 * longer, exactly as it does for every other calibrated number in this
 * project.
 *
 * Note the state SPREAD, which is deliberately not hidden: a brand-new
 * player's early state is several times slower than a mid-game one for any
 * COUNT-based target (100 wins is ~92 minutes there). That is accepted
 * rather than engineered away — dailies are a bonus layer, missing one costs
 * a player nothing they had, and the income-scaled Revenue entry (whose
 * completion time is nearly state-independent by construction, 10-16 min
 * across all four states) is always in the draw as the great equaliser.
 */
export const DAILY_OBJECTIVE_POOL: ObjectiveConfig[] = [
  {
    id: 'daily-wins-any-100',
    statTracked: 'totalWins',
    targetKind: 'fixed',
    targetAmount: 100,
    describe: (n) => `Win ${n.toLocaleString()} matches today (any sport)`,
    rewardIncomeRateSeconds: 65,
    rewardMinAmount: 975,
  },
  {
    id: 'daily-wins-soccer-60',
    statTracked: 'soccerWins',
    targetKind: 'fixed',
    targetAmount: 60,
    describe: (n) => `Win ${n.toLocaleString()} soccer matches today`,
    rewardIncomeRateSeconds: 85,
    rewardMinAmount: 1275,
  },
  {
    id: 'daily-wins-baseball-60',
    statTracked: 'baseballWins',
    targetKind: 'fixed',
    targetAmount: 60,
    describe: (n) => `Win ${n.toLocaleString()} baseball matches today`,
    rewardIncomeRateSeconds: 50,
    rewardMinAmount: 750,
    // Same eligibility rule as the rotating pool's baseball entry: never
    // drawn for a player who owns no baseball tier, since they could not
    // progress it at all — and a daily has only ONE slot, so an
    // unprogressable draw would waste their whole day rather than sitting
    // beside two workable siblings.
    requiresStatPositive: 'baseballTiersUnlocked',
  },
  {
    id: 'daily-training-20',
    statTracked: 'totalTierLevels',
    targetKind: 'fixed',
    targetAmount: 20,
    describe: (n) => `Improve training ${n} times today (any tier)`,
    rewardIncomeRateSeconds: 50,
    rewardMinAmount: 750,
  },
  {
    id: 'daily-earn-revenue-1800s',
    statTracked: 'franchiseEarnings',
    targetKind: 'incomeRateSeconds',
    targetAmount: 1800,
    describe: (n) => `Earn ${n.toLocaleString()} Revenue today`,
    rewardIncomeRateSeconds: 65,
    rewardMinAmount: 975,
  },
]

/**
 * WEEKLY POOL — one drawn per rolling 7-day window. Same calibration method
 * as the daily pool above, sized to roughly a week's accumulated session
 * time. Simulated medians:
 *   wins-any 700 -> ~92 min | wins-soccer 300 -> ~88 min
 *   wins-baseball 500 -> ~84 min | earn-revenue 10800s -> ~83 min
 * — an unusually tight cluster (83-92 min), which matters more here than for
 * any other tier: every weekly pays the SAME Legacy Points, so they should
 * cost roughly the same effort whichever one is drawn.
 *
 * ── WHY THERE IS NO TRAINING ENTRY HERE, unlike the daily pool ──
 * Upgrade cost is exponential in level, so a training target's completion
 * time explodes with a player's state: 40 training levels measured 12 min
 * (mid), 172 min (late) and 69 HOURS (early) — a ~200x spread, versus ~10x
 * for win targets and under 2x for the income-scaled Revenue one. A single
 * weekly slot holding the only Legacy-Point-bearing objective in the game is
 * the worst possible place to put that variance, so this pool deliberately
 * sticks to the well-behaved stats. The daily pool keeps its own training
 * entry at a much smaller target (20), where the spread is tolerable and a
 * missed day costs nothing.
 */
export const WEEKLY_OBJECTIVE_POOL: ObjectiveConfig[] = [
  {
    id: 'weekly-wins-any-700',
    statTracked: 'totalWins',
    targetKind: 'fixed',
    targetAmount: 700,
    describe: (n) => `Win ${n.toLocaleString()} matches this week (any sport)`,
    rewardIncomeRateSeconds: 440,
    rewardMinAmount: 6600,
    rewardLegacyPoints: WEEKLY_LEGACY_POINT_REWARD,
  },
  {
    id: 'weekly-wins-soccer-300',
    statTracked: 'soccerWins',
    targetKind: 'fixed',
    targetAmount: 300,
    describe: (n) => `Win ${n.toLocaleString()} soccer matches this week`,
    rewardIncomeRateSeconds: 420,
    rewardMinAmount: 6300,
    rewardLegacyPoints: WEEKLY_LEGACY_POINT_REWARD,
  },
  {
    id: 'weekly-wins-baseball-500',
    statTracked: 'baseballWins',
    targetKind: 'fixed',
    targetAmount: 500,
    describe: (n) => `Win ${n.toLocaleString()} baseball matches this week`,
    rewardIncomeRateSeconds: 400,
    rewardMinAmount: 6000,
    rewardLegacyPoints: WEEKLY_LEGACY_POINT_REWARD,
    requiresStatPositive: 'baseballTiersUnlocked',
  },
  {
    id: 'weekly-earn-revenue-10800s',
    statTracked: 'franchiseEarnings',
    targetKind: 'incomeRateSeconds',
    targetAmount: 10800,
    describe: (n) => `Earn ${n.toLocaleString()} Revenue this week`,
    rewardIncomeRateSeconds: 400,
    rewardMinAmount: 6000,
    rewardLegacyPoints: WEEKLY_LEGACY_POINT_REWARD,
  },
]

export function periodicObjectivePool(kind: PeriodicObjectiveKind): ObjectiveConfig[] {
  return kind === 'daily' ? DAILY_OBJECTIVE_POOL : WEEKLY_OBJECTIVE_POOL
}

/**
 * POOL-SCOPED config lookup — the counterpart to `objectiveConfigById`,
 * which searches only the rotating pool.
 *
 * The scoping is load-bearing, not stylistic. A single "search every pool"
 * lookup would let a hand-edited save move a WEEKLY config id (the only
 * configs carrying `rewardLegacyPoints`) into the fast-rotating `objectives`
 * array, where it would be granted and re-drawn on a roughly per-minute
 * cycle — turning a deliberately scarce 5-points-per-7-days reward into an
 * unbounded Legacy Point faucet. With pool-scoped lookups, the rotating
 * sanitizer sees an unknown id and drops it, and the daily slot rejects a
 * weekly id (and vice versa) the same way.
 */
export function periodicObjectiveConfigById(
  kind: PeriodicObjectiveKind,
  configId: string,
): ObjectiveConfig | undefined {
  return periodicObjectivePool(kind).find((c) => c.id === configId)
}

export function periodicObjectiveProgress(
  kind: PeriodicObjectiveKind,
  active: ActiveObjective,
  stats: Record<string, number>,
): ObjectiveProgress | null {
  const config = periodicObjectiveConfigById(kind, active.configId)
  if (!config) return null
  return progressForConfig(config, active, stats)
}

/**
 * One daily/weekly slot's persisted state.
 *
 * `completed` is a stored FLAG rather than something re-derived from
 * progress, and that is a genuine requirement of the capped-completion
 * behaviour, not redundancy: a rotating objective is replaced the instant it
 * completes, so it can never be granted twice, whereas a daily/weekly stays
 * in place until its boundary passes. Without a flag, a completed daily
 * would re-qualify on every subsequent tick and pay out endlessly. It also
 * survives a prestige re-baseline (which can push a run-scoped stat back
 * below its baseline) without the reward becoming re-claimable.
 *
 * BOTH boundary fields are written on every reset, and each kind reads only
 * the one that defines its own boundary:
 *   - `lastResetDate` — the local calendar date key ('YYYY-MM-DD') at the
 *     last reset. DAILY compares today's key against it; any difference
 *     means a new day. Comparing local date KEYS (rather than elapsed
 *     milliseconds) is what makes the daily boundary land on the player's
 *     own midnight, and it is inherently DST-proof: a 23- or 25-hour day is
 *     still exactly one date change.
 *   - `lastResetMs` — the epoch timestamp of the last reset. WEEKLY measures
 *     its rolling 7 days from this.
 * Storing both costs nothing, keeps one shared state shape and one shared
 * reset path for the two kinds, and leaves each boundary rule expressed in
 * the units it is actually about.
 */
export interface PeriodicObjectiveState {
  objective: ActiveObjective | null
  completed: boolean
  lastResetDate: string
  lastResetMs: number
}

/**
 * The player's LOCAL calendar date as a stable 'YYYY-MM-DD' key. Local, not
 * UTC, per the requirement that the daily boundary be the player's own
 * midnight on their own device.
 *
 * Known, accepted consequence: a player who travels far enough west can see
 * a local date EARLIER than the stored one, which reads as a difference and
 * so grants them a fresh daily that day. Every local-date daily in every
 * offline game has this property, it is self-limiting (one extra daily, and
 * only on a travel day), and the daily tier grants Revenue only — never
 * Legacy Points, whose window is measured in milliseconds and is completely
 * unaffected by timezone changes.
 */
export function localDateKey(nowMs: number): string {
  const d = new Date(nowMs)
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}

/** Milliseconds until the next local midnight. `setHours(24, 0, 0, 0)` is
 *  the DST-correct way to express "start of the next local day" — the Date
 *  object normalises the overflow through the local timezone, so a 23-hour
 *  or 25-hour day yields the correct remaining time rather than a hardcoded
 *  24-hour assumption. */
function msUntilNextLocalMidnight(nowMs: number): number {
  const d = new Date(nowMs)
  d.setHours(24, 0, 0, 0)
  return Math.max(0, d.getTime() - nowMs)
}

/** Milliseconds until this slot's next reset — the number behind the
 *  "completed — resets in <time>" state. Never negative; 0 means the
 *  boundary has already passed and the next resolve will redraw. */
export function msUntilPeriodReset(
  kind: PeriodicObjectiveKind,
  state: PeriodicObjectiveState,
  nowMs: number,
): number {
  if (kind === 'daily') return msUntilNextLocalMidnight(nowMs)
  const elapsed = nowMs - state.lastResetMs
  if (!Number.isFinite(elapsed)) return 0
  return Math.max(0, WEEKLY_PERIOD_MS - elapsed)
}

/** Whether this slot's boundary has passed and it is due a fresh draw. */
export function isPeriodElapsed(
  kind: PeriodicObjectiveKind,
  state: PeriodicObjectiveState,
  nowMs: number,
): boolean {
  if (kind === 'daily') return localDateKey(nowMs) !== state.lastResetDate
  const elapsed = nowMs - state.lastResetMs
  if (!Number.isFinite(elapsed)) return true
  return elapsed >= WEEKLY_PERIOD_MS
}

/**
 * Draws one eligible config from this kind's pool.
 *
 * `excludeConfigId` is the currently-assigned one, so consecutive periods
 * don't hand a player the identical objective twice in a row — dropped if it
 * would leave nothing eligible (e.g. a soccer-only player with a small
 * eligible set), because a repeat is better than an empty slot.
 * Eligibility (`requiresStatPositive`) is NEVER relaxed the same way: an
 * ineligible objective is one the player structurally cannot progress.
 */
export function drawPeriodicObjective(
  kind: PeriodicObjectiveKind,
  stats: Record<string, number>,
  random: () => number = Math.random,
  excludeConfigId?: string,
): ObjectiveConfig | null {
  const eligible = periodicObjectivePool(kind).filter(
    (c) => !c.requiresStatPositive || (stats[c.requiresStatPositive] ?? 0) > 0,
  )
  if (eligible.length === 0) return null
  const preferred = eligible.filter((c) => c.id !== excludeConfigId)
  const candidates = preferred.length > 0 ? preferred : eligible
  const index = Math.min(candidates.length - 1, Math.floor(random() * candidates.length))
  return candidates[index]
}

/**
 * A fresh slot state for `nowMs` — a newly drawn objective baselined against
 * the CURRENT stats (so it always means "N more from here", never crediting
 * work already done), with both boundary fields anchored to now.
 *
 * This is also the "no catch-up" rule in code: a player returning after
 * missing five days or three weeks gets exactly ONE fresh objective anchored
 * to the moment they came back — missed periods are never stacked, queued or
 * backfilled, and the next boundary is a full period away from their return
 * rather than from whenever they last played.
 */
export function createPeriodicObjectiveState(
  kind: PeriodicObjectiveKind,
  stats: Record<string, number>,
  incomeRatePerSecond: number,
  nowMs: number,
  random: () => number = Math.random,
  excludeConfigId?: string,
): PeriodicObjectiveState {
  const config = drawPeriodicObjective(kind, stats, random, excludeConfigId)
  const statValue = config ? stats[config.statTracked] ?? 0 : 0
  return {
    objective: config
      ? {
          configId: config.id,
          baseline: Number.isFinite(statValue) ? statValue : 0,
          target: resolveObjectiveTarget(config, incomeRatePerSecond),
        }
      : null,
    completed: false,
    lastResetDate: localDateKey(nowMs),
    lastResetMs: nowMs,
  }
}

export interface PeriodicResolution {
  state: PeriodicObjectiveState
  /** Revenue to ADD (0 when nothing completed) — a delta, so a caller can
   *  stack it on whatever it already computed this frame. */
  revenueReward: number
  /** Legacy Points to ADD. Only ever non-zero for the weekly kind. */
  legacyPointsReward: number
  /** True exactly on the frame the reward was granted. */
  granted: boolean
  /** True exactly on the frame the boundary passed and a new objective was
   *  drawn. */
  reset: boolean
}

/**
 * The single evaluation path for one daily/weekly slot — grant, then reset.
 *
 * Order matters and is deliberate: a player who completes the objective in
 * the same instant the boundary passes is paid for it BEFORE the slot rolls
 * over. The reverse order would silently swallow a legitimately earned
 * reward at midnight.
 *
 * Steps:
 *  1. CLOCK-REWIND GUARD. If `nowMs` is before the stored reset time, the
 *     device clock has moved backwards (a manual change, a timezone/NTP
 *     correction). The weekly window is re-anchored to now rather than left
 *     pointing into the future, so a player is not stranded waiting out the
 *     old timestamp PLUS a full 7 days. This never grants anything and never
 *     redraws, and it cannot shorten a window: the next weekly is still a
 *     full 7 days from that re-anchored moment.
 *  2. GRANT. If an objective is assigned, not yet completed, and its
 *     progress has reached target, pay the Revenue (through the shared
 *     `scaledRevenueReward`, the same function achievements and rotating
 *     objectives use) plus any Legacy Points, and latch `completed`.
 *  3. RESET. If the boundary has passed — or the slot holds no valid
 *     objective at all (a corrupted or emptied save) — draw a fresh one.
 *     Note this is the ONLY redraw path: a completed objective sits in its
 *     "completed" state until here, which is the capped-completion rule.
 *
 * `getIncomeRatePerSecond` is a lazy thunk for the same reason the rotating
 * and achievement paths use one: it loops every tier of both sports, this
 * runs on every tick, and the overwhelming majority of ticks neither grant
 * nor reset. It is memoised so a grant-and-reset in the same frame prices
 * both against one consistent snapshot of the economy.
 */
export function resolvePeriodicObjective(
  kind: PeriodicObjectiveKind,
  state: PeriodicObjectiveState,
  stats: Record<string, number>,
  nowMs: number,
  getIncomeRatePerSecond: () => number,
  random: () => number = Math.random,
): PeriodicResolution {
  let next = state
  let revenueReward = 0
  let legacyPointsReward = 0
  let granted = false

  let rate: number | null = null
  const rateOnce = () => (rate ??= getIncomeRatePerSecond())

  // 1. Clock-rewind guard.
  if (Number.isFinite(nowMs) && nowMs < next.lastResetMs) {
    next = { ...next, lastResetMs: nowMs }
  }

  // 2. Grant.
  const active = next.objective
  const config = active ? periodicObjectiveConfigById(kind, active.configId) : undefined
  if (active && config && !next.completed) {
    const progress = progressForConfig(config, active, stats)
    if (progress.complete) {
      revenueReward = scaledRevenueReward(
        config.rewardIncomeRateSeconds,
        config.rewardMinAmount,
        rateOnce(),
      )
      legacyPointsReward = Math.max(0, Math.round(config.rewardLegacyPoints ?? 0))
      granted = true
      next = { ...next, completed: true }
    }
  }

  // 3. Reset. `!config` covers a slot holding nothing, or holding an id this
  //    kind's pool no longer recognises (a removed entry, or a hand-edited
  //    cross-pool id) — either way it can never progress, so it is replaced
  //    immediately rather than left dead until the boundary.
  const reset = !config || isPeriodElapsed(kind, next, nowMs)
  if (reset) {
    next = createPeriodicObjectiveState(
      kind,
      stats,
      rateOnce(),
      Number.isFinite(nowMs) ? nowMs : next.lastResetMs,
      random,
      active?.configId,
    )
  }

  return { state: next, revenueReward, legacyPointsReward, granted, reset }
}

/**
 * Re-baselines a periodic slot's RUN-SCOPED objective against post-prestige
 * stats — the periodic counterpart of the rotating array's own re-baselining
 * (see OBJECTIVE_STAT_SCOPES for why run-scoped objectives need this at all:
 * a prestige zeroes tier state, leaving a stale baseline permanently above
 * the live stat and the objective permanently unachievable).
 *
 * A daily/weekly slot deliberately SURVIVES a prestige rather than resetting
 * with it — these are time-based commitments, not run-based ones, and a
 * player who prestiges on day 3 of a weekly should not lose the week.
 *
 * An ALREADY-COMPLETED slot is left entirely alone: its reward is banked and
 * its `completed` flag is what the UI shows, so re-baselining it would only
 * churn numbers nothing reads.
 */
export function rebaselinePeriodicObjective(
  kind: PeriodicObjectiveKind,
  state: PeriodicObjectiveState,
  postResetStats: Record<string, number>,
  postResetIncomeRate: number,
): PeriodicObjectiveState {
  const active = state.objective
  if (!active || state.completed) return state
  const config = periodicObjectiveConfigById(kind, active.configId)
  if (!config) return state
  if (OBJECTIVE_STAT_SCOPES[config.statTracked] !== 'run') return state
  return {
    ...state,
    objective: {
      ...active,
      baseline: postResetStats[config.statTracked] ?? 0,
      // An income-scaled target must be re-resolved too, for the same reason
      // the rotating path re-resolves its own: a target sized against a
      // pre-prestige economy would take orders of magnitude longer against a
      // freshly-reset one. Safe because resolveObjectiveTarget floors the
      // RATE (OBJECTIVE_FLOOR_INCOME_RATE), so a post-reset rate of zero
      // cannot collapse the target to a degenerate 1.
      target:
        config.targetKind === 'incomeRateSeconds'
          ? resolveObjectiveTarget(config, postResetIncomeRate)
          : active.target,
    },
  }
}

/**
 * Sanitizes a persisted periodic slot of UNKNOWN shape — the same
 * never-trust-persisted-shape posture the store applies to
 * tiers/lifetimeStats/achievements/objectives, extended to this new field.
 *
 * Returns null for anything unusable so the caller can create a fresh slot.
 * A slot whose objective is individually malformed (or names a config this
 * kind's pool doesn't have — including a cross-pool id, which is the Legacy
 * Point faucet this scoping exists to prevent) keeps its boundary
 * timestamps but drops the objective to null; `resolvePeriodicObjective`
 * then redraws it on the very next evaluation without also handing the
 * player a fresh period.
 *
 * `completed` is coerced to a real boolean, and a completed slot with no
 * valid objective is downgraded to not-completed, so a corrupted save can
 * never present as "already claimed" for a reward it never received.
 */
export function sanitizePeriodicObjectiveState(
  kind: PeriodicObjectiveKind,
  value: unknown,
): PeriodicObjectiveState | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<PeriodicObjectiveState>
  if (typeof raw.lastResetDate !== 'string' || !Number.isFinite(raw.lastResetMs)) return null

  let objective: ActiveObjective | null = null
  const candidate = raw.objective
  if (candidate && typeof candidate === 'object') {
    const { configId, baseline, target } = candidate as Partial<ActiveObjective>
    if (
      typeof configId === 'string' &&
      periodicObjectiveConfigById(kind, configId) &&
      Number.isFinite(baseline) &&
      Number.isFinite(target)
    ) {
      objective = { configId, baseline: baseline as number, target: Math.max(1, target as number) }
    }
  }

  return {
    objective,
    completed: objective ? raw.completed === true : false,
    lastResetDate: raw.lastResetDate,
    lastResetMs: raw.lastResetMs as number,
  }
}
