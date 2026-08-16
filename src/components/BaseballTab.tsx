import { useNowMs, AUTO_PLAY_PAUSE_CHECK_MS } from '../hooks/useMatchTicker'
import { BASEBALL_VENTURE_TIERS } from '../sports/baseball/baseballModule'
import BaseballVentureCard from './BaseballVentureCard'
import AchievementsPanel from './AchievementsPanel'

/** The Baseball tab (see CLAUDE.md's tabbed-navigation amendment) —
 *  baseball's own achievement line and venture tier cards only. No reveal
 *  slicing needed here (unlike SoccerTab) — baseball has no hidden-until-
 *  prestige tiers; every tier is either locked (its own unlock purchase) or
 *  unlocked, always rendered. */
function BaseballTab() {
  // ONE clock for every card on this tab (see useNowMs) — the cards need a
  // moving `nowMs` to notice their own auto-play pausing, and a per-card
  // interval would mean one timer per tier. A minute of granularity is far
  // finer than a four-hour threshold needs.
  const nowMs = useNowMs(AUTO_PLAY_PAUSE_CHECK_MS)

  return (
    <div>
      <AchievementsPanel statKeys={['baseballWins']} />
      <div className="venture-list">
        {BASEBALL_VENTURE_TIERS.map((config) => (
          <BaseballVentureCard key={config.id} tierId={config.id} nowMs={nowMs} />
        ))}
      </div>
    </div>
  )
}

export default BaseballTab
