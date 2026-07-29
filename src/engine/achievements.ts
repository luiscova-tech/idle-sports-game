// ============================================================
// src/engine/achievements.ts
// Sport-agnostic achievement/badge framework. Like economy.ts and
// prestige.ts, this only ever consumes a generic stats record
// (Record<string, number>) supplied by the caller — this file must never
// import from src/sports/** and has zero special-casing for any single
// stat. Adding a new achievement LINE (e.g. total Revenue earned, matches
// played, prestige count) is purely a matter of adding entries to
// ACHIEVEMENTS/STAT_LABELS below; the store is separately responsible for
// tracking that stat and including it in the record passed to
// checkNewlyEarnedAchievements() (see CLAUDE.md "Achievements" section).
// ============================================================

/**
 * A discriminated union, not just a closed `type` string — 'scaledRevenue'
 * (added alongside the income-rate-scaled-rewards amendment, see CLAUDE.md)
 * needs different fields (`incomeRateSeconds`/`minAmount`) than the flat
 * `amount` 'revenue'/'legacyPoints' carry, so each variant only has the
 * fields it actually uses rather than an `amount` that's sometimes ignored.
 */
export type AchievementReward =
  | { type: 'revenue'; amount: number }
  | { type: 'legacyPoints'; amount: number }
  | {
      type: 'scaledRevenue'
      /** How many seconds' worth of the player's CURRENT aggregate income
       *  rate (see engine/ventureTiers.ts's tierIncomeRatePerSecond) this
       *  reward grants, computed fresh at the moment of completion — never
       *  cached or precomputed ahead of time, so it reflects wherever the
       *  player's economy actually is when they cross the threshold. */
      incomeRateSeconds: number
      /** Floor beneath which this reward can never fall — matters for a
       *  genuinely zero-income-rate case (a player who reached this
       *  threshold via manual clicks alone, with no manager EVER hired on
       *  any tier of any sport: tierIncomeRatePerSecond returns exactly 0
       *  for a manager-less tier, since manual clicking isn't a "rate").
       *  Set to this achievement's OLD flat reward amount for every
       *  converted entry below, so no save is ever worse off than before
       *  this amendment, only potentially much better off. */
      minAmount: number
    }

/**
 * Exhaustiveness guard for AchievementReward. Every if/else chain over a
 * reward's `type` must end with `else return assertNeverRewardType(reward)`
 * (passing the whole, by-then-narrowed-to-`never` reward — NOT
 * `reward.type`) — if a fourth variant is ever added to the union above
 * without updating that chain, this becomes a compile error instead of a
 * silent wrong-currency-granted bug (e.g. a new reward type quietly falling
 * through into the 'legacyPoints' branch of a non-exhaustive chain).
 *
 * Deliberately an if/else chain, not a `switch`, at both call sites
 * (useGameStore.ts's reward-granting loop, AchievementsPanel.tsx's
 * `rewardLabel`) — and this takes the WHOLE narrowed `reward`, not
 * `reward.type` — because of a real, verified quirk in this project's exact
 * TypeScript/tsconfig combination: a `switch` on a 3+-variant discriminated
 * union's discriminant, ending in `default: return
 * assertNeverRewardType(reward.type)`, fails to narrow `reward.type` to
 * `never` in the default branch (surfacing as a confusing "Argument of type
 * 'any' is not assignable to parameter of type 'never'"), even though the
 * exact same union narrows correctly through an `if/else` chain, and even
 * though passing the whole `reward` object (rather than reading `.type` off
 * of it) narrows correctly in BOTH forms. Confirmed via isolated repro files
 * compiled with this project's own tsconfig before choosing this pattern —
 * not a style preference, a verified compiler-compatibility requirement.
 */
export function assertNeverRewardType(reward: never): never {
  throw new Error(`Unhandled achievement reward: ${JSON.stringify(reward)}`)
}

/** Display label per `statTracked` key, for grouping badges in the UI. A
 *  new achievement line adds one entry here alongside its ACHIEVEMENTS
 *  entries — `as const` makes this object the single source of truth for
 *  every known stat key (see StatKey below), rather than a plain
 *  `Record<string, string>` that couldn't catch a typo anywhere else. */
export const STAT_LABELS = {
  totalWins: 'Total Wins',
  soccerWins: 'Soccer Wins',
  baseballWins: 'Baseball Wins',
} as const

/** Every known stat key an achievement line can track, derived from
 *  STAT_LABELS' own keys rather than hand-maintained separately — adding a
 *  new achievement line's one required STAT_LABELS entry (per that
 *  object's own doc comment) automatically widens this type too, so
 *  AchievementConfig.statTracked and AchievementsPanel's statKeys prop
 *  (src/components/AchievementsPanel.tsx) can both be typed against it.
 *  This is NOT the "widen a union type by hand" cost the old `statTracked:
 *  string` doc comment was written to avoid — an adversarial review caught
 *  that being fully untyped let a typo (in either a new ACHIEVEMENTS entry
 *  or a tab's statKeys array) silently render an empty Achievements panel
 *  with no error, since a stringly-typed mismatch just filters every
 *  achievement out. Deriving StatKey from STAT_LABELS costs nothing beyond
 *  the entry every new line already has to add there. */
export type StatKey = keyof typeof STAT_LABELS

/** 'Bronze' | 'Silver' | 'Gold' are this session's only tiers, but `tier`
 *  is a plain string on purpose — a future line can introduce its own
 *  (e.g. 'Platinum') without widening a union type here. `statTracked`
 *  is NOT similarly open-ended (see StatKey above) — the two fields are
 *  deliberately treated differently: a new TIER name is purely cosmetic
 *  (nothing else needs to agree with it), while a new STAT key has to
 *  agree with whatever the store tracks and whatever a tab's statKeys
 *  filters on, which is exactly the kind of cross-file agreement a shared
 *  type is for. */
export interface AchievementConfig {
  id: string
  name: string
  /** Key into the stats record passed to checkNewlyEarnedAchievements() —
   *  e.g. 'totalWins'. */
  statTracked: StatKey
  threshold: number
  tier: string
  reward: AchievementReward
}

/**
 * First achievement line: total wins across every venture tier of EVERY
 * sport combined (not per-tier, not per-sport) — see CLAUDE.md "Achievements"
 * for the threshold/reward derivation (grounded in a simulation of realistic
 * play speed). Bronze and Silver reward Revenue; Gold rewards Legacy Points,
 * deliberately bridging the run currency into the permanent one.
 *
 * Audited when baseball was added as a second sport, and again when the
 * two per-sport lines below were added: `totalWins` already correctly
 * counts baseball wins alongside soccer wins (see useGameStore.ts's
 * tickTier/tickBaseballTier — both increment the exact same
 * `lifetimeStats.totalWins` field from their own completed-match branch),
 * so no fix was ever needed here for that.
 */
export const ACHIEVEMENTS: AchievementConfig[] = [
  // A very-low-threshold onboarding nudge, deliberately NOT tiered as
  // 'Bronze' — Bronze/Silver/Gold stay real, deliberately-paced milestones
  // (see the derivation above); this is a separate, much smaller welcome
  // reward so a brand-new player has *something* to earn in their first
  // session without cheapening what "Bronze" means. Pure config addition —
  // no component/CSS changes needed, since `tier` is an open string and
  // AchievementsPanel.css already has a generic fallback style for any
  // tier name outside Bronze/Silver/Gold.
  {
    id: 'total-wins-first',
    name: 'First Win',
    statTracked: 'totalWins',
    threshold: 1,
    tier: 'Rookie',
    reward: { type: 'revenue', amount: 20 },
  },
  // Bronze/Silver were originally FLAT Revenue (200/2000) — converted to
  // income-rate-scaled rewards (see AchievementReward's 'scaledRevenue'
  // variant and CLAUDE.md's income-rate-scaled-rewards amendment for the
  // full derivation) once a simulation showed those flat numbers had become
  // trivial: even at the ORIGINAL calibration point (50 wins, the greedy
  // hyper-engaged sim this line's own threshold was tuned against), the
  // player's actual current income rate was already ~12,466 Revenue/SECOND
  // (milestone-multiplier compounding + the margin-bonus formula, both
  // added in later sessions than this line's own original 200/2000
  // numbers, are what did it) — 200 Revenue was worth a mere 0.016 SECONDS
  // of that rate, nowhere near "a nudge." `minAmount` keeps each entry's OLD
  // flat number as a floor, so a save is never worse off than before this
  // amendment — only a genuinely zero-income-rate case (every tier of every
  // sport unmanaged, wins earned via pure manual clicking) would ever still
  // see the old flat number.
  {
    id: 'total-wins-bronze',
    name: 'Fifty Victories',
    statTracked: 'totalWins',
    threshold: 50,
    tier: 'Bronze',
    reward: { type: 'scaledRevenue', incomeRateSeconds: 10, minAmount: 200 },
  },
  {
    id: 'total-wins-silver',
    name: 'Two-Fifty Club',
    statTracked: 'totalWins',
    threshold: 250,
    tier: 'Silver',
    reward: { type: 'scaledRevenue', incomeRateSeconds: 30, minAmount: 2000 },
  },
  {
    id: 'total-wins-gold',
    name: 'Thousand-Win Dynasty',
    statTracked: 'totalWins',
    threshold: 1000,
    tier: 'Gold',
    reward: { type: 'legacyPoints', amount: 10 },
  },

  // Second and third achievement lines: per-sport win counts, added
  // alongside the tabbed-navigation restructuring so each sport's tab can
  // show its own badge progress (see CLAUDE.md's tabbed-navigation
  // amendment). Deliberately smaller rewards than the combined `totalWins`
  // line above (roughly half, at each matching tier) — these are a fun
  // sport-specific complement to the "biggest" combined milestone, not a
  // second copy of the same reward.
  //
  // THRESHOLD DERIVATION — calibrated independently per sport via a direct-
  // import Node harness driving the real soccerModule/baseballModule/
  // ventureTiers code (not a reimplementation), simulating the same greedy
  // "unlock next tier > hire manager > train" policy at 1 manual click/sec
  // plus each tier's own real auto-tick interval once a manager is hired —
  // the same methodology this project's original totalWins thresholds used
  // (see this file's own history in CLAUDE.md). Soccer's own pace (over its
  // 6 starting tiers) reached 50/250/1000 wins at ~19.2/78.8/302.8 simulated
  // minutes under the CURRENT economy — close enough to the original
  // 15.6/67/260-minute derivation (from years of intervening balance
  // changes: milestone multipliers, the margin-bonus formula, etc.) that the
  // existing 50/250/1000 numbers were kept for "Soccer Wins" rather than
  // changed, now re-validated against the current codebase rather than
  // merely inherited.
  //
  // Baseball's own simulation (over its 3 tiers, isolated from however long
  // it took to first afford unlocking Tee Time) reaches equivalent WIN
  // COUNTS meaningfully faster in real time than soccer does — baseball has
  // no draw state (a strictly higher effective win rate than soccer's
  // win/draw/loss split) and its early tiers' shorter, variable-inning
  // matches complete in fewer ticks than soccer's fixed 90. Copying
  // soccer's 50/250/1000 onto baseball would have made baseball's badges
  // trivially fast to earn relative to soccer's — instead, baseball's
  // thresholds (75/300/1200) were chosen as the win counts that land at
  // roughly the SAME simulated time targets soccer's own 50/250/1000 hit
  // (~19/79/303 min): the simulation's own data points and interpolation
  // put 75 wins at ~17.7 min, 300 at ~71.9 min, and 1200 at ~272.4 min —
  // meaningfully different numbers than soccer's, by design, because
  // baseball genuinely produces wins faster per unit of real time.
  // Bronze/Silver here use HALF the combined totalWins line's own
  // incomeRateSeconds (5s/15s vs. 10s/30s) — preserving the exact same
  // "per-sport line pays roughly half of the equivalent combined tier"
  // relationship this project already established for the old flat
  // numbers (100/1000 vs. 200/2000), just re-expressed in seconds instead
  // of a now-meaningless absolute amount. See the totalWins Bronze/Silver
  // comment above and CLAUDE.md's income-rate-scaled-rewards amendment for
  // the full derivation.
  {
    id: 'soccer-wins-bronze',
    name: 'Pitch Perfect Fifty',
    statTracked: 'soccerWins',
    threshold: 50,
    tier: 'Bronze',
    reward: { type: 'scaledRevenue', incomeRateSeconds: 5, minAmount: 100 },
  },
  {
    id: 'soccer-wins-silver',
    name: 'Quarter-Thousand Kicks',
    statTracked: 'soccerWins',
    threshold: 250,
    tier: 'Silver',
    reward: { type: 'scaledRevenue', incomeRateSeconds: 15, minAmount: 1000 },
  },
  {
    id: 'soccer-wins-gold',
    name: 'Thousand-Win Gaffer',
    statTracked: 'soccerWins',
    threshold: 1000,
    tier: 'Gold',
    reward: { type: 'legacyPoints', amount: 5 },
  },
  {
    id: 'baseball-wins-bronze',
    name: 'Diamond Debut',
    statTracked: 'baseballWins',
    threshold: 75,
    tier: 'Bronze',
    reward: { type: 'scaledRevenue', incomeRateSeconds: 5, minAmount: 100 },
  },
  {
    id: 'baseball-wins-silver',
    name: 'Three Hundred Club',
    statTracked: 'baseballWins',
    threshold: 300,
    tier: 'Silver',
    reward: { type: 'scaledRevenue', incomeRateSeconds: 15, minAmount: 1000 },
  },
  {
    id: 'baseball-wins-gold',
    name: 'Hall of Fame Bound',
    statTracked: 'baseballWins',
    threshold: 1200,
    tier: 'Gold',
    reward: { type: 'legacyPoints', amount: 5 },
  },
]

/** Which of the not-yet-earned achievements now qualify, given the current
 *  value of every tracked stat. Pure — applies no rewards itself and
 *  mutates nothing; the caller (store) grants each returned achievement's
 *  `reward` and records its id as earned. */
export function checkNewlyEarnedAchievements(
  stats: Record<string, number>,
  earnedIds: readonly string[],
): AchievementConfig[] {
  const earned = new Set(earnedIds)
  return ACHIEVEMENTS.filter(
    (achievement) =>
      !earned.has(achievement.id) && (stats[achievement.statTracked] ?? 0) >= achievement.threshold,
  )
}
