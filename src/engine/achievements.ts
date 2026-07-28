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

export interface AchievementReward {
  type: 'revenue' | 'legacyPoints'
  amount: number
}

/** Exhaustiveness guard for AchievementReward['type']. Every switch over a
 *  reward's `type` must end with `default: assertNeverRewardType(reward.type)`
 *  — if a third variant is ever added to the union above without updating
 *  that switch, this becomes a compile error instead of a silent
 *  wrong-currency-granted bug (e.g. a new reward type quietly falling
 *  through into the 'legacyPoints' branch of a non-exhaustive if/else). */
export function assertNeverRewardType(type: never): never {
  throw new Error(`Unhandled achievement reward type: ${JSON.stringify(type)}`)
}

/** 'Bronze' | 'Silver' | 'Gold' are this session's only tiers, but `tier`
 *  is a plain string on purpose — a future line can introduce its own
 *  (e.g. 'Platinum') without widening a union type here. */
export interface AchievementConfig {
  id: string
  name: string
  /** Key into the stats record passed to checkNewlyEarnedAchievements() —
   *  e.g. 'totalWins'. A plain string, not an enum, so a new stat is just
   *  a new key the store starts tracking and reporting. */
  statTracked: string
  threshold: number
  tier: string
  reward: AchievementReward
}

/** Display label per `statTracked` key, for grouping badges in the UI.
 *  A new achievement line adds one entry here alongside its ACHIEVEMENTS
 *  entries. */
export const STAT_LABELS: Record<string, string> = {
  totalWins: 'Total Wins',
}

/**
 * First achievement line: total wins across every venture tier combined
 * (not per-tier) — see CLAUDE.md "Achievements" for the threshold/reward
 * derivation (grounded in a simulation of realistic play speed). Bronze
 * and Silver reward Revenue; Gold rewards Legacy Points, deliberately
 * bridging the run currency into the permanent one.
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
  {
    id: 'total-wins-bronze',
    name: 'Fifty Victories',
    statTracked: 'totalWins',
    threshold: 50,
    tier: 'Bronze',
    reward: { type: 'revenue', amount: 200 },
  },
  {
    id: 'total-wins-silver',
    name: 'Two-Fifty Club',
    statTracked: 'totalWins',
    threshold: 250,
    tier: 'Silver',
    reward: { type: 'revenue', amount: 2000 },
  },
  {
    id: 'total-wins-gold',
    name: 'Thousand-Win Dynasty',
    statTracked: 'totalWins',
    threshold: 1000,
    tier: 'Gold',
    reward: { type: 'legacyPoints', amount: 10 },
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
