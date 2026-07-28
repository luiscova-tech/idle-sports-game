import { useGameStore } from '../store/useGameStore'
import { useMatchTicker } from '../hooks/useMatchTicker'
import { SOCCER_VENTURE_TIERS } from '../sports/soccer/soccerModule'
import VentureCard from '../components/VentureCard'

function Home() {
  const isInitialized = useGameStore((state) => state.isInitialized)
  const revenue = useGameStore((state) => state.currencies.revenue)
  const resetProgress = useGameStore((state) => state.resetProgress)
  useMatchTicker()

  const handleReset = () => {
    if (window.confirm('Reset all progress? This clears your save and cannot be undone.')) {
      resetProgress()
    }
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1 className="app-header__title">Idle Sports Franchise Builder</h1>
        <p className="app-header__status">
          Engine Online · Game store initialized: {String(isInitialized)}
        </p>
        <div className="app-header__revenue">
          <span className="app-header__revenue-label">Total Revenue</span>
          <span className="app-header__revenue-value">{revenue}</span>
        </div>
        <button type="button" className="app-header__reset" onClick={handleReset}>
          Reset Progress
        </button>
      </header>

      <div className="venture-list">
        {SOCCER_VENTURE_TIERS.map((config) => (
          <VentureCard key={config.id} tierId={config.id} />
        ))}
      </div>
    </div>
  )
}

export default Home
