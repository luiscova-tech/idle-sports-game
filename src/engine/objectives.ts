// ============================================================
// src/engine/objectives.ts
// Config-driven short-term "Objectives" system — a small rotating set of
// 2-3 goals shown on the Hub. Sport-agnostic in exactly the same way
// achievements.ts is: this file only ever consumes a generic stats record
// (Record<string, number>) supplied by the store, never imports from
// src/sports/**, and has zero special-casing for any single stat. Adding a
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
