import { useGameStore } from '../store/useGameStore'
import LegacyPanel from './LegacyPanel'
import AchievementsPanel from './AchievementsPanel'
import './FranchiseTab.css'

/**
 * The Franchise tab (see CLAUDE.md's tabbed-navigation amendment) — the
 * meta-progression home: Legacy/Prestige, combined stats spanning BOTH
 * sports, the lifetime-combined "Total Wins" achievement line, and
 * developer tools. Total Revenue itself stays out of this tab entirely — it
 * lives in the persistent app header, visible on every tab, since it's
 * shared currency rather than something specific to this tab (see
 * Home.tsx).
 *
 * Settings consolidation decision (per this session's instruction to pick
 * one and document it): the old standalone `/settings` route is REMOVED
 * entirely and its one piece of content (the DEV wipe button) is folded
 * directly into this tab, rather than kept as a separate linked sub-page.
 * With only 3 tabs now, a 4th page reachable via a small link would have
 * been the exact "main screen -> tiny settings link -> settings page"
 * indirection tabs are replacing — folding it in means it's still exactly
 * one tap away from the default (Soccer) tab, same as before, with no
 * extra page/route left over.
 */
function FranchiseTab() {
  const tiers = useGameStore((s) => s.tiers)
  const baseballTiers = useGameStore((s) => s.baseballTiers)
  const prestigeCount = useGameStore((s) => s.legacy.prestigeCount)
  const resetProgress = useGameStore((s) => s.resetProgress)

  // Combined across both sports — purely derived from data each tier
  // already tracks (cumulativeRevenue/matchesCompleted), so this needed no
  // new store fields. Achievement Revenue rewards are NOT included (they're
  // deliberately never added to any tier's cumulativeRevenue — see
  // CLAUDE.md's achievements section) — this is "Revenue earned through
  // match play across both sports," not literally every Revenue increment
  // ever, matching cumulativeRevenue's own existing documented scope.
  const allTiers = [...tiers, ...baseballTiers]
  const totalRevenueEarned = allTiers.reduce((sum, t) => sum + t.cumulativeRevenue, 0)
  const totalMatches = allTiers.reduce((sum, t) => sum + t.matchesCompleted, 0)

  const handleDevWipe = () => {
    const confirmed = window.confirm(
      'DEV RESET: this wipes EVERYTHING — Revenue, every tier, AND your Legacy Points/permanent ' +
        "upgrades. This is not the normal prestige reset; if you just want to prestige, use " +
        '"Reset for Legacy" above instead. This cannot be undone. Continue?',
    )
    if (confirmed) resetProgress()
  }

  return (
    <div>
      <LegacyPanel />

      <section className="franchise-stats" aria-label="Combined franchise stats">
        <h2 className="franchise-stats__title">Franchise Stats</h2>
        <div className="franchise-stats__grid">
          <div className="franchise-stats__stat">
            <span className="franchise-stats__label">Total Revenue Earned</span>
            <span className="franchise-stats__value">{totalRevenueEarned.toLocaleString()}</span>
          </div>
          <div className="franchise-stats__stat">
            <span className="franchise-stats__label">Total Matches</span>
            <span className="franchise-stats__value">{totalMatches.toLocaleString()}</span>
          </div>
          <div className="franchise-stats__stat">
            <span className="franchise-stats__label">Prestige Count</span>
            <span className="franchise-stats__value">{prestigeCount.toLocaleString()}</span>
          </div>
        </div>
      </section>

      <AchievementsPanel statKeys={['totalWins']} />

      <section className="settings-section" aria-label="Developer tools">
        <h2 className="settings-section__title">Developer Tools</h2>
        <p className="settings-section__desc">
          For testing only — not part of normal play. If you want to prestige, use "Reset for Legacy"
          above instead.
        </p>
        <button type="button" className="app-header__reset" onClick={handleDevWipe}>
          DEV: Wipe All Data
        </button>
      </section>
    </div>
  )
}

export default FranchiseTab
