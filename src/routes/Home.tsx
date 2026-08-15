import { useState } from 'react'
import { useGameStore } from '../store/useGameStore'
import Hub, { type BuildingId } from '../components/Hub'
import SoccerTab from '../components/SoccerTab'
import BaseballTab from '../components/BaseballTab'
import FranchiseTab from '../components/FranchiseTab'

/** 'hub' is the landing view; the other three are the building interiors —
 *  the exact same content the old tab bar rendered, unchanged. */
type ViewId = 'hub' | BuildingId

const BUILDING_TITLES: Record<BuildingId, string> = {
  soccer: '⚽ Soccer',
  baseball: '⚾ Baseball',
  franchise: '🏆 Franchise HQ',
}

/**
 * Hub-based main screen (superseding the three-tab bar described in
 * CLAUDE.md's tabbed-navigation amendment, which itself superseded the
 * original single combined-list screen).
 *
 * NAVIGATION MODEL: the hub is the default/landing view on EVERY load —
 * deliberately not "remember last screen." `useState<ViewId>('hub')` is
 * component-local and never persisted (it's absent from the store entirely,
 * so `partialize` can't carry it), so a reload always lands on the hub
 * regardless of where the player was. Tapping a building FULLY REPLACES the
 * view with that screen's existing content (not an overlay or drill-down),
 * and every screen renders a persistent "back to hub" control.
 *
 * TECHNICAL APPROACH: this extends the existing component-local view-
 * switching mechanism with one more state value rather than introducing URL
 * routing — deliberately the lower-risk option, reusing what was already
 * built and verified. The consequence that matters most is unchanged and
 * strengthened: switching views is a plain `setState`, NOT a navigation
 * event, so `useMatchTicker` (mounted once in App.tsx, unconditionally,
 * above this component) is structurally untouchable by view changes. This
 * project has hit a real navigation-pause regression before (the old
 * /settings route), so that guarantee is re-verified in the browser each
 * time this layer changes rather than assumed — see CLAUDE.md.
 *
 * Total Revenue stays in the persistent header, visible on the hub AND
 * inside every building — it's one shared currency across both sports (see
 * useGameStore.ts's currency-separation-by-type principle), not something
 * scoped to any one screen the way each sport's tier list is.
 */
function Home() {
  const [view, setView] = useState<ViewId>('hub')
  const isInitialized = useGameStore((state) => state.isInitialized)
  const revenue = useGameStore((state) => state.currencies.revenue)

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
      </header>

      {view === 'hub' ? (
        <Hub onEnter={setView} />
      ) : (
        <>
          <div className="screen-bar">
            <button type="button" className="back-to-hub" onClick={() => setView('hub')}>
              <span aria-hidden="true">←</span> Back to hub
            </button>
            <h2 className="screen-bar__title">{BUILDING_TITLES[view]}</h2>
          </div>

          {view === 'soccer' && <SoccerTab />}
          {view === 'baseball' && <BaseballTab />}
          {view === 'franchise' && <FranchiseTab />}
        </>
      )}
    </div>
  )
}

export default Home
