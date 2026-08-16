import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Home from './routes/Home'
import { useAppHeartbeat, useMatchTicker, usePeriodicObjectives } from './hooks/useMatchTicker'
import NotificationToasts from './components/NotificationToasts'
import './App.css'

function App() {
  // FIRST, deliberately: effects run in declaration order, and this one
  // credits back any time the app spent CLOSED before the ticker below can
  // fire ticks that would otherwise be judged against stale inactivity
  // stamps. See useAppHeartbeat.
  useAppHeartbeat()
  // Owns the idle loop regardless of which tab is active, so auto-play
  // keeps progressing while a player is on the Franchise tab (or any other
  // tab) — an idle game shouldn't pause its core loop just because a menu
  // is open. Tabs are now plain component-local state inside Home (see
  // CLAUDE.md's tabbed-navigation amendment, which also removed the old
  // standalone /settings route this comment used to reference) rather than
  // separate routes, so this hook being mounted here — above Home, above
  // every tab — is an even stronger guarantee than before: there is no
  // route transition of any kind between tabs for it to be affected by.
  useMatchTicker()
  // Mounted here for exactly the same reason, and with an extra one of its
  // own: the Daily/Weekly boundary must keep being checked even when NO tier
  // is auto-playing (no managers hired means no ticks at all, so nothing
  // else would ever notice midnight passing).
  usePeriodicObjectives()

  return (
    <BrowserRouter>
      {/* Rendered outside <Routes> for the same reason useMatchTicker is
          called unconditionally above — a training milestone crossed by an
          auto-playing manager should surface no matter which tab the
          player is currently on. */}
      <NotificationToasts />
      <Routes>
        <Route path="/" element={<Home />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
