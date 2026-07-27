import { useGameStore } from '../store/useGameStore'

const OUTCOME_LABEL: Record<'win' | 'draw' | 'loss', string> = {
  win: 'WIN',
  draw: 'DRAW',
  loss: 'LOSS',
}

function MatchPanel() {
  const match = useGameStore((state) => state.match)
  const matchesCompleted = useGameStore((state) => state.matchesCompleted)
  const revenue = useGameStore((state) => state.currencies.revenue)
  const lastOutcome = useGameStore((state) => state.lastOutcome)

  return (
    <div>
      <h2>
        {match.homeScore} - {match.awayScore}
      </h2>
      <p>Match clock: {match.elapsedTicks}'</p>
      <p>Revenue: {revenue}</p>
      <p>Matches completed: {matchesCompleted}</p>
      {lastOutcome && <p>Last result: {OUTCOME_LABEL[lastOutcome]}</p>}
    </div>
  )
}

export default MatchPanel
