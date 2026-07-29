import { useState } from 'react'
import { useGameStore } from '../store/useGameStore'
import SoccerTab from '../components/SoccerTab'
import BaseballTab from '../components/BaseballTab'
import FranchiseTab from '../components/FranchiseTab'

type TabId = 'soccer' | 'baseball' | 'franchise'

const TABS: { id: TabId; label: string; icon: string }[] = [
  { id: 'soccer', label: 'Soccer', icon: '⚽' },
  { id: 'baseball', label: 'Baseball', icon: '⚾' },
  { id: 'franchise', label: 'Franchise', icon: '🏆' },
]

/**
 * Three-tab main screen (see CLAUDE.md's tabbed-navigation amendment,
 * superseding the earlier single combined-list screen described in the
 * "Venture tiers" amendment). Tabs are plain component-local state, not
 * routes — switching tabs never touches react-router, so there is no
 * navigation event of any kind for useMatchTicker (mounted once in App.tsx,
 * unconditionally, above this component) to be affected by. That's a
 * stronger structural guarantee than the old /settings route ever had: it's
 * not just "the hook happens to live above the route," there is no route
 * transition here at all — every tab's tiers keep ticking in the store
 * regardless of which tab is currently rendered, since the auto-tick
 * intervals only ever call store actions directly and were never coupled to
 * what's mounted below. Verified directly in the browser regardless (see
 * CLAUDE.md) rather than assumed from this reasoning alone.
 *
 * Total Revenue stays in this persistent header, visible across all three
 * tabs — it's one shared currency (see useGameStore.ts's own currency-
 * separation-by-type-not-by-tab principle), not something scoped to any one
 * tab the way each tab's own achievement line or tier list is.
 */
function Home() {
  const [activeTab, setActiveTab] = useState<TabId>('soccer')
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

      <nav className="tab-nav" aria-label="Main sections">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`tab-nav__button ${activeTab === tab.id ? 'tab-nav__button--active' : ''}`}
            aria-current={activeTab === tab.id ? 'page' : undefined}
            onClick={() => setActiveTab(tab.id)}
          >
            <span aria-hidden="true">{tab.icon}</span> {tab.label}
          </button>
        ))}
      </nav>

      {activeTab === 'soccer' && <SoccerTab />}
      {activeTab === 'baseball' && <BaseballTab />}
      {activeTab === 'franchise' && <FranchiseTab />}
    </div>
  )
}

export default Home
