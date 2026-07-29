import { Link } from 'react-router-dom'
import { useGameStore } from '../store/useGameStore'
import { SOCCER_VENTURE_TIERS, revealedTierCount } from '../sports/soccer/soccerModule'
import { BASEBALL_VENTURE_TIERS } from '../sports/baseball/baseballModule'
import SoccerVentureCard from '../components/SoccerVentureCard'
import BaseballVentureCard from '../components/BaseballVentureCard'
import LegacyPanel from '../components/LegacyPanel'
import AchievementsPanel from '../components/AchievementsPanel'

function Home() {
  const isInitialized = useGameStore((state) => state.isInitialized)
  const revenue = useGameStore((state) => state.currencies.revenue)
  const prestigeCount = useGameStore((state) => state.legacy.prestigeCount)

  // Tiers 7-11 (legends-circuit onward) don't exist in the UI at all until
  // revealed — one at a time, per completed prestige (see revealedTierCount)
  // — and stay revealed permanently for that save once shown (prestigeCount
  // never decreases on a normal prestige reset, only on the full dev wipe on
  // the Settings page).
  const visibleSoccerTiers = SOCCER_VENTURE_TIERS.slice(0, revealedTierCount(prestigeCount))

  return (
    <div className="app-shell">
      <header className="app-header">
        <Link to="/settings" className="app-header__settings-link" aria-label="Settings">
          ⚙
        </Link>
        <h1 className="app-header__title">Idle Sports Franchise Builder</h1>
        <p className="app-header__status">
          Engine Online · Game store initialized: {String(isInitialized)}
        </p>
        <div className="app-header__revenue">
          <span className="app-header__revenue-label">Total Revenue</span>
          <span className="app-header__revenue-value">{revenue}</span>
        </div>
      </header>

      <LegacyPanel />
      <AchievementsPanel />

      {/* Soccer and baseball tiers share ONE combined list — they share the
          same Revenue currency and the same visual card language, so they
          read as one coherent venture portfolio rather than two separate
          games bolted together (see CLAUDE.md's "Baseball" amendment).
          Baseball tiers render after soccer's — unlike soccer's reveal
          mechanic, baseball has no hidden-until-prestige tiers to slice
          out; entering the sport at all is gated by Tee Time's own locked-
          card unlock purchase instead. */}
      <div className="venture-list">
        {visibleSoccerTiers.map((config) => (
          <SoccerVentureCard key={config.id} tierId={config.id} />
        ))}
        {BASEBALL_VENTURE_TIERS.map((config) => (
          <BaseballVentureCard key={config.id} tierId={config.id} />
        ))}
      </div>
    </div>
  )
}

export default Home
