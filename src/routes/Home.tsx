import { Link } from 'react-router-dom'
import { useGameStore } from '../store/useGameStore'
import { SOCCER_VENTURE_TIERS, revealedTierCount } from '../sports/soccer/soccerModule'
import VentureCard from '../components/VentureCard'
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
  const visibleTiers = SOCCER_VENTURE_TIERS.slice(0, revealedTierCount(prestigeCount))

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

      <div className="venture-list">
        {visibleTiers.map((config) => (
          <VentureCard key={config.id} tierId={config.id} />
        ))}
      </div>
    </div>
  )
}

export default Home
