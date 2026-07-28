import { useGameStore } from '../store/useGameStore'
import { useMatchTicker } from '../hooks/useMatchTicker'
import { SOCCER_VENTURE_TIERS, TIERS_REVEALED_BEFORE_PRESTIGE } from '../sports/soccer/soccerModule'
import VentureCard from '../components/VentureCard'
import LegacyPanel from '../components/LegacyPanel'

function Home() {
  const isInitialized = useGameStore((state) => state.isInitialized)
  const revenue = useGameStore((state) => state.currencies.revenue)
  const hasPrestiged = useGameStore((state) => state.legacy.hasPrestiged)
  const resetProgress = useGameStore((state) => state.resetProgress)
  useMatchTicker()

  // Tiers 7-11 (legends-circuit onward) don't exist in the UI at all until
  // a player's first prestige — this permanently reveals them for that
  // save going forward (hasPrestiged never reverts on a normal prestige
  // reset, only on the full dev wipe below).
  const visibleTiers = hasPrestiged
    ? SOCCER_VENTURE_TIERS
    : SOCCER_VENTURE_TIERS.slice(0, TIERS_REVEALED_BEFORE_PRESTIGE)

  // A developer/debug affordance, not a player-facing feature — this wipes
  // EVERYTHING including Legacy Points and permanent upgrades, unlike the
  // real "Reset for Legacy" prestige action in LegacyPanel. Deliberately
  // labeled and confirm-worded to be unmistakably distinct from that button
  // so a real player can't confuse the two and lose Legacy progress to a
  // misclick.
  const handleDevWipe = () => {
    const confirmed = window.confirm(
      'DEV RESET: this wipes EVERYTHING — Revenue, every tier, AND your Legacy Points/permanent ' +
        "upgrades. This is not the normal prestige reset; if you just want to prestige, use " +
        '"Reset for Legacy" above instead. This cannot be undone. Continue?',
    )
    if (confirmed) resetProgress()
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
        <button type="button" className="app-header__reset" onClick={handleDevWipe}>
          DEV: Wipe All Data
        </button>
      </header>

      <LegacyPanel />

      <div className="venture-list">
        {visibleTiers.map((config) => (
          <VentureCard key={config.id} tierId={config.id} />
        ))}
      </div>
    </div>
  )
}

export default Home
