import { BASEBALL_VENTURE_TIERS } from '../sports/baseball/baseballModule'
import BaseballVentureCard from './BaseballVentureCard'
import AchievementsPanel from './AchievementsPanel'

/** The Baseball tab (see CLAUDE.md's tabbed-navigation amendment) —
 *  baseball's own achievement line and venture tier cards only. No reveal
 *  slicing needed here (unlike SoccerTab) — baseball has no hidden-until-
 *  prestige tiers; every tier is either locked (its own unlock purchase) or
 *  unlocked, always rendered. */
function BaseballTab() {
  return (
    <div>
      <AchievementsPanel statKeys={['baseballWins']} />
      <div className="venture-list">
        {BASEBALL_VENTURE_TIERS.map((config) => (
          <BaseballVentureCard key={config.id} tierId={config.id} />
        ))}
      </div>
    </div>
  )
}

export default BaseballTab
