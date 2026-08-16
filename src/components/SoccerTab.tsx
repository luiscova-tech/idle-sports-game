import { useGameStore } from '../store/useGameStore'
import { useNowMs, AUTO_PLAY_PAUSE_CHECK_MS } from '../hooks/useMatchTicker'
import { SOCCER_VENTURE_TIERS, revealedTierCount } from '../sports/soccer/soccerModule'
import SoccerVentureCard from './SoccerVentureCard'
import AchievementsPanel from './AchievementsPanel'

/** The Soccer tab (see CLAUDE.md's tabbed-navigation amendment) — soccer's
 *  own achievement line and venture tier cards only. Tiers 7-11 stay sliced
 *  out here exactly as they were on the old combined screen (see
 *  revealedTierCount) — moving to tabs changed nothing about the reveal
 *  mechanic itself. */
function SoccerTab() {
  const prestigeCount = useGameStore((state) => state.legacy.prestigeCount)
  const visibleSoccerTiers = SOCCER_VENTURE_TIERS.slice(0, revealedTierCount(prestigeCount))
  // ONE clock for every card on this tab (see useNowMs) — the cards need a
  // moving `nowMs` to notice their own auto-play pausing, and a per-card
  // interval would mean one timer per tier. A minute of granularity is far
  // finer than a four-hour threshold needs.
  const nowMs = useNowMs(AUTO_PLAY_PAUSE_CHECK_MS)


  return (
    <div>
      <AchievementsPanel statKeys={['soccerWins']} />
      <div className="venture-list">
        {visibleSoccerTiers.map((config) => (
          <SoccerVentureCard key={config.id} tierId={config.id} nowMs={nowMs} />
        ))}
      </div>
    </div>
  )
}

export default SoccerTab
