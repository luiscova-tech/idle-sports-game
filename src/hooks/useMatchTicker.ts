import { useEffect } from 'react'
import { useGameStore } from '../store/useGameStore'
import { SOCCER_TICK_INTERVAL_MS } from '../sports/soccer/soccerModule'

/**
 * Owns the idle loop's timer — the only setInterval in the codebase. On
 * every firing it ticks every unlocked tier that has hired a manager,
 * independently. All tiers share this one interval since they all run
 * through the same underlying sport module/pacing. Takes intervalMs as a
 * parameter so a future sport can supply its own pacing without changing
 * this hook.
 */
export function useMatchTicker(intervalMs: number = SOCCER_TICK_INTERVAL_MS) {
  const tickTier = useGameStore((s) => s.tickTier)
  // A stable, order-preserving key so the effect only resets when the SET
  // of auto-playing tiers changes — not on every match tick (which would
  // otherwise recreate the interval on every score change).
  const autoTierKey = useGameStore((s) =>
    s.tiers
      .filter((t) => t.unlocked && t.managerHired)
      .map((t) => t.id)
      .join(','),
  )

  useEffect(() => {
    const autoTierIds = autoTierKey ? autoTierKey.split(',') : []
    if (autoTierIds.length === 0) return

    const id = setInterval(() => {
      autoTierIds.forEach((tierId) => tickTier(tierId))
    }, intervalMs)
    return () => clearInterval(id)
  }, [tickTier, autoTierKey, intervalMs])
}
