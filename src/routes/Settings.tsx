import { Link } from 'react-router-dom'
import { useGameStore } from '../store/useGameStore'

// A developer/debug affordance, not a player-facing feature — this wipes
// EVERYTHING including Legacy Points and permanent upgrades, unlike the
// real "Reset for Legacy" prestige action on the main screen. Deliberately
// moved onto its own page (out of the main header) so it's never one
// accidental tap away during normal play, while still being reachable
// without browser devtools. Same dashed-border/monospace styling and
// explicit confirm dialog as before — only its location changed.
function Settings() {
  const resetProgress = useGameStore((state) => state.resetProgress)

  const handleDevWipe = () => {
    const confirmed = window.confirm(
      'DEV RESET: this wipes EVERYTHING — Revenue, every tier, AND your Legacy Points/permanent ' +
        "upgrades. This is not the normal prestige reset; if you just want to prestige, use " +
        '"Reset for Legacy" on the main screen instead. This cannot be undone. Continue?',
    )
    if (confirmed) resetProgress()
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1 className="app-header__title">Settings</h1>
        <Link to="/" className="settings-page__back-link">
          ← Back to game
        </Link>
      </header>

      <section className="settings-section" aria-label="Developer tools">
        <h2 className="settings-section__title">Developer Tools</h2>
        <p className="settings-section__desc">
          For testing only — not part of normal play. If you want to prestige, use "Reset for
          Legacy" on the main screen instead.
        </p>
        <button type="button" className="app-header__reset" onClick={handleDevWipe}>
          DEV: Wipe All Data
        </button>
      </section>
    </div>
  )
}

export default Settings
