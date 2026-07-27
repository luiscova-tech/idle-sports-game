import { useGameStore } from '../store/useGameStore'

function Home() {
  const isInitialized = useGameStore((state) => state.isInitialized)

  return (
    <section style={{ margin: 'auto', textAlign: 'center' }}>
      <h1>Idle Sports Franchise Builder</h1>
      <p>Engine Online</p>
      <p>
        Game store initialized: <strong>{String(isInitialized)}</strong>
      </p>
    </section>
  )
}

export default Home
