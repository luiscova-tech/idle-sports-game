import { useGameStore, MANAGER_HIRE_COST } from '../store/useGameStore'

// "Push the Attack" stays available even after auto-play unlocks, as a
// supplemental manual boost on top of the idle loop, rather than being
// hidden — the classic idle-game pattern of active play still mattering
// after automation is earned.
function MatchControls() {
  const tick = useGameStore((state) => state.tick)
  const hireManager = useGameStore((state) => state.hireManager)
  const autoPlayUnlocked = useGameStore((state) => state.autoPlayUnlocked)
  const revenue = useGameStore((state) => state.currencies.revenue)

  return (
    <div>
      <button type="button" onClick={tick}>
        Push the Attack
      </button>
      {autoPlayUnlocked ? (
        <p>Manager hired — matches now auto-advance.</p>
      ) : (
        <button type="button" onClick={hireManager} disabled={revenue < MANAGER_HIRE_COST}>
          Hire a Manager (costs {MANAGER_HIRE_COST} Revenue)
        </button>
      )}
    </div>
  )
}

export default MatchControls
