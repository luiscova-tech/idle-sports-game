import { useGameStore } from '../store/useGameStore'
import {
  ACHIEVEMENTS,
  STAT_LABELS,
  assertNeverRewardType,
  nearestAchievementProgress,
  type AchievementReward,
  type StatKey,
} from '../engine/achievements'
import './AchievementsPanel.css'

const TIER_BADGE_CLASS: Record<string, string> = {
  Bronze: 'achievement-badge--bronze',
  Silver: 'achievement-badge--silver',
  Gold: 'achievement-badge--gold',
}

// An if/else chain, not a `switch` — see assertNeverRewardType's own doc
// comment (engine/achievements.ts) for why: a verified quirk in this
// project's exact TypeScript/tsconfig combination fails to narrow a
// 3+-variant discriminated union's discriminant to `never` in a switch's
// `default` branch, even though the identical union narrows correctly
// through an if/else chain. Still fully exhaustive — adding a fourth reward
// variant without updating this chain is a compile error, not a silently
// wrong "+N Legacy Points" label for a reward that isn't Legacy Points.
function rewardLabel(reward: AchievementReward): string {
  if (reward.type === 'revenue') {
    return `+${reward.amount} Revenue`
  } else if (reward.type === 'legacyPoints') {
    return `+${reward.amount} Legacy Points`
  } else if (reward.type === 'scaledRevenue') {
    // The exact Revenue amount can't be shown ahead of time — it's
    // computed fresh from the player's OWN current income rate at the
    // moment of completion (see CLAUDE.md's income-rate-scaled-rewards
    // amendment), so showing a stale precomputed number here would
    // misrepresent it. Describing the TIME quantity instead stays honest
    // and legible regardless of how large a player's economy has grown.
    return `~${reward.incomeRateSeconds}s of current income`
  } else {
    return assertNeverRewardType(reward)
  }
}

interface AchievementsPanelProps {
  /** Which achievement lines (by `statTracked` key) to render — e.g. the
   *  Soccer tab passes `['soccerWins']` to show only its own line, while the
   *  Franchise tab passes `['totalWins']` for the combined one (see
   *  CLAUDE.md's tabbed-navigation amendment). Omit to render every line —
   *  the original, pre-tabs behavior — so this stays a filter, not a
   *  required prop. Typed as `StatKey[]`, not `string[]` — an adversarial
   *  review caught that a plain `string[]` here couldn't catch a typo'd
   *  key at a call site (the achievement panel would just silently render
   *  its header with zero lines beneath it, indistinguishable from "nothing
   *  earned yet"); StatKey ties this to the same source of truth
   *  AchievementConfig.statTracked uses. */
  statKeys?: StatKey[]
}

// Groups ACHIEVEMENTS by statTracked so this stays correct with zero
// changes here when a new achievement line is added to the engine config
// — one more group just appears. Distinct visual system on purpose (see
// index.css's --color-achievement*/--color-badge-* tokens) — its own
// currency-agnostic system, separate from both the tier cards and Legacy.
function AchievementsPanel({ statKeys }: AchievementsPanelProps) {
  // The one explicit adapter step a new achievement line needs outside of
  // engine/achievements.ts's config: map whatever lifetime stat it tracks
  // into this generic stats record, keyed the same as that line's
  // `statTracked`. Three entries exist today (totalWins, plus soccerWins/
  // baseballWins added alongside the tabbed-navigation restructuring).
  const totalWins = useGameStore((s) => s.lifetimeStats.totalWins)
  const soccerWins = useGameStore((s) => s.lifetimeStats.soccerWins)
  const baseballWins = useGameStore((s) => s.lifetimeStats.baseballWins)
  const stats: Record<string, number> = { totalWins, soccerWins, baseballWins }

  const earnedIds = useGameStore((s) => s.achievements.earnedIds)
  const earnedSet = new Set(earnedIds)

  // Which lines to render, in ACHIEVEMENTS' own declaration order. The
  // per-line sorting/next-unearned/progress derivation itself lives in
  // nearestAchievementProgress (engine/achievements.ts) rather than here,
  // so Hub.tsx's at-a-glance teaser computes it from the exact same
  // function this panel does — see that helper's own doc comment.
  const lineKeys: StatKey[] = []
  for (const achievement of ACHIEVEMENTS) {
    if (statKeys && !statKeys.includes(achievement.statTracked)) continue
    if (!lineKeys.includes(achievement.statTracked)) lineKeys.push(achievement.statTracked)
  }

  return (
    <section className="achievements-panel" aria-label="Achievements">
      <h2 className="achievements-panel__title">Achievements</h2>

      {lineKeys.map((statKey) => {
        const { sorted, currentValue, nextUnearned, progressPercent } = nearestAchievementProgress(
          stats,
          earnedIds,
          statKey,
        )

        return (
          <div className="achievement-line" key={statKey}>
            <div className="achievement-line__header">
              <span className="achievement-line__label">{STAT_LABELS[statKey] ?? statKey}</span>
              <span className="achievement-line__value">
                {currentValue.toLocaleString()}
                {nextUnearned ? ` / ${nextUnearned.threshold.toLocaleString()}` : ' — all earned'}
              </span>
            </div>

            <div className="achievement-line__progress-track">
              <div
                className="achievement-line__progress-fill"
                style={{ width: `${progressPercent}%` }}
              />
            </div>

            <div className="achievement-badges">
              {sorted.map((achievement) => {
                const earned = earnedSet.has(achievement.id)
                return (
                  <div
                    key={achievement.id}
                    className={`achievement-badge ${
                      TIER_BADGE_CLASS[achievement.tier] ?? 'achievement-badge--other'
                    } ${earned ? 'achievement-badge--earned' : 'achievement-badge--locked'}`}
                  >
                    {earned && (
                      <span className="achievement-badge__check" aria-hidden="true">
                        ✓
                      </span>
                    )}
                    <span className="achievement-badge__tier">{achievement.tier}</span>
                    <span className="achievement-badge__name">{achievement.name}</span>
                    <span className="achievement-badge__threshold">
                      {achievement.threshold.toLocaleString()}
                    </span>
                    <span className="achievement-badge__reward">{rewardLabel(achievement.reward)}</span>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </section>
  )
}

export default AchievementsPanel
