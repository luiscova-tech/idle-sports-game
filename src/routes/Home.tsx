import { useGameStore } from '../store/useGameStore'
import { useMatchTicker } from '../hooks/useMatchTicker'
import { SOCCER_VENTURE_TIERS } from '../sports/soccer/soccerModule'
import VentureCard from '../components/VentureCard'

function Home() {
  const isInitialized = useGameStore((state) => state.isInitialized)
  const revenue = useGameStore((state) => state.currencies.revenue)
  useMatchTicker()

  return (
    <section style={{ margin: 'auto', textAlign: 'center' }}>
      <h1>Idle Sports Franchise Builder</h1>
      <p>Engine Online</p>
      <p>
        Game store initialized: <strong>{String(isInitialized)}</strong>
      </p>
      <p>Total Revenue: {revenue}</p>
      <div>
        {SOCCER_VENTURE_TIERS.map((config) => (
          <VentureCard key={config.id} tierId={config.id} />
        ))}
      </div>
    </section>
  )
}

export default Home
