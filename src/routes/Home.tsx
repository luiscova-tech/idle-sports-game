import { Link } from 'react-router-dom'
import { useGameStore } from '../store/useGameStore'
import { SOCCER_VENTURE_TIERS, TIERS_REVEALED_BEFORE_PRESTIGE } from '../sports/soccer/soccerModule'
import VentureCard from '../components/VentureCard'
import LegacyPanel from '../components/LegacyPanel'
import AchievementsPanel from '../components/AchievementsPanel'

function Home() {
  const isInitialized = useGameStore((state) => state.isInitialized)
  const revenue = useGameStore((state) => state.currencies.revenue)
  const hasPrestiged = useGameStore((state) => state.legacy.hasPrestiged)

  // Tiers 7-11 (legends-circuit onward) don't exist in the UI at all until
  // a player's first prestige — this permanently reveals them for that
  // save going forward (hasPrestiged never reverts on a normal prestige
  // reset, only on the full dev wipe on the Settings page).
  const visibleTiers = hasPrestiged
    ? SOCCER_VENTURE_TIERS
    : SOCCER_VENTURE_TIERS.slice(0, TIERS_REVEALED_BEFORE_PRESTIGE)

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
