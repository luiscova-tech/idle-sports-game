import { useGameStore } from '../store/useGameStore'
import { useMatchTicker } from '../hooks/useMatchTicker'
import MatchPanel from '../components/MatchPanel'

function Home() {
  const isInitialized = useGameStore((state) => state.isInitialized)
  useMatchTicker()

  return (
    <section style={{ margin: 'auto', textAlign: 'center' }}>
      <h1>Idle Sports Franchise Builder</h1>
      <p>Engine Online</p>
      <p>
        Game store initialized: <strong>{String(isInitialized)}</strong>
      </p>
      <MatchPanel />
    </section>
  )
}

export default Home
