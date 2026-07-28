import { useGameStore } from '../store/useGameStore'
import {
  ACHIEVEMENTS,
  STAT_LABELS,
  assertNeverRewardType,
  type AchievementReward,
} from '../engine/achievements'
import './AchievementsPanel.css'

const TIER_BADGE_CLASS: Record<string, string> = {
  Bronze: 'achievement-badge--bronze',
  Silver: 'achievement-badge--silver',
  Gold: 'achievement-badge--gold',
}

// Exhaustive over AchievementReward['type'] — adding a third reward
// variant without updating this switch is a compile error, not a silently
// wrong "+N Legacy Points" label for a reward that isn't Legacy Points.
function rewardLabel(reward: AchievementReward): string {
  switch (reward.type) {
    case 'revenue':
      return `+${reward.amount} Revenue`
    case 'legacyPoints':
      return `+${reward.amount} Legacy Points`
    default:
      return assertNeverRewardType(reward.type)
  }
}

// Groups ACHIEVEMENTS by statTracked so this stays correct with zero
// changes here when a new achievement line is added to the engine config
// — one more group just appears. Distinct visual system on purpose (see
// index.css's --color-achievement*/--color-badge-* tokens) — its own
// currency-agnostic system, separate from both the tier cards and Legacy.
function AchievementsPanel() {
  // The one explicit adapter step a new achievement line needs outside of
  // engine/achievements.ts's config: map whatever lifetime stat it tracks
  // into this generic stats record, keyed the same as that line's
  // `statTracked`. Only one entry exists today (totalWins).
  const totalWins = useGameStore((s) => s.lifetimeStats.totalWins)
  const stats: Record<string, number> = { totalWins }

  const earnedIds = useGameStore((s) => s.achievements.earnedIds)
  const earnedSet = new Set(earnedIds)

  const groups = new Map<string, typeof ACHIEVEMENTS>()
  for (const achievement of ACHIEVEMENTS) {
    const line = groups.get(achievement.statTracked) ?? []
    line.push(achievement)
    groups.set(achievement.statTracked, line)
  }

  return (
    <section className="achievements-panel" aria-label="Achievements">
      <h2 className="achievements-panel__title">Achievements</h2>

      {Array.from(groups.entries()).map(([statKey, lineAchievements]) => {
        const sorted = [...lineAchievements].sort((a, b) => a.threshold - b.threshold)
        const currentValue = stats[statKey] ?? 0
        const nextUnearned = sorted.find((a) => !earnedSet.has(a.id))
        const progressPercent = nextUnearned
          ? Math.min(100, Math.round((currentValue / nextUnearned.threshold) * 100))
          : 100

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
