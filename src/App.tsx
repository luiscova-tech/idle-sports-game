import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Home from './routes/Home'
import { useMatchTicker } from './hooks/useMatchTicker'
import NotificationToasts from './components/NotificationToasts'
import './App.css'

function App() {
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
