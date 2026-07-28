import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Home from './routes/Home'
import Settings from './routes/Settings'
import { useMatchTicker } from './hooks/useMatchTicker'
import NotificationToasts from './components/NotificationToasts'
import './App.css'

function App() {
  // Owns the idle loop regardless of which route is active, so auto-play
  // keeps progressing while a player is on the Settings page — an idle
  // game shouldn't pause its core loop just because a menu is open.
  useMatchTicker()

  return (
    <BrowserRouter>
      {/* Rendered outside <Routes> for the same reason useMatchTicker is
          called unconditionally above — a training milestone crossed by an
          auto-playing manager should surface no matter which page the
          player is currently on. */}
      <NotificationToasts />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
