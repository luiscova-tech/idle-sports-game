import { useEffect, useRef } from 'react'
import { useGameStore } from '../store/useGameStore'
import { SOCCER_VENTURE_TIERS, autoTickIntervalMsForTier } from '../sports/soccer/soccerModule'

/**
 * Owns the idle loop's timers — the only setIntervals in the codebase. Each
 * auto-playing tier gets its OWN interval at its OWN real-world pace (see
 * autoTickIntervalMsForTier — higher tiers auto-tick meaningfully slower),
 * rather than one shared interval ticking every tier identically. A manual
 * "Push the Attack" click never goes through this hook at all — it calls
 * tickTier() directly from VentureCard.tsx — so manual play always resolves
 * instantly regardless of tier, unaffected by any of these intervals.
 *
 * Intervals are tracked in a ref, keyed by tier id, and only ADDED/REMOVED
 * as a diff against the current auto-playing set — never blanket torn down
 * and recreated. That distinction matters now that tiers have wildly
 * different intervals (600ms to ~17s): an earlier version recreated EVERY
 * interval whenever the SET of auto-tiers changed at all, so hiring a
 * manager for a brand-new low tier would reset a high tier's in-flight
 * countdown back to zero — with a long enough interval and frequent enough
 * manager hires, a high tier's auto-play could be perpetually restarted
 * before ever firing. Diffing means an unrelated tier's timer is never
 * touched by another tier's manager-hire/unlock/lock event.
 */
export function useMatchTicker() {
  const tickTier = useGameStore((s) => s.tickTier)
  // A stable, order-preserving key so the effect only re-diffs when the SET
  // of auto-playing tiers changes — not on every match tick (which would
  // otherwise re-diff on every score change).
  const autoTierKey = useGameStore((s) =>
    s.tiers
      .filter((t) => t.unlocked && t.managerHired)
      .map((t) => t.id)
      .join(','),
  )

  const intervalsRef = useRef(new Map<string, ReturnType<typeof setInterval>>())

  useEffect(() => {
    const autoTierIds = new Set(autoTierKey ? autoTierKey.split(',') : [])
    const intervals = intervalsRef.current

    for (const [tierId, intervalId] of intervals) {
      if (!autoTierIds.has(tierId)) {
        clearInterval(intervalId)
        intervals.delete(tierId)
      }
    }

    for (const tierId of autoTierIds) {
      if (intervals.has(tierId)) continue
      const tierIndex = SOCCER_VENTURE_TIERS.findIndex((c) => c.id === tierId)
      const intervalMs = autoTickIntervalMsForTier(tierIndex)
      intervals.set(tierId, setInterval(() => tickTier(tierId), intervalMs))
    }
  }, [tickTier, autoTierKey])

  // Unmount-only cleanup — the effect above already clears any interval
  // whose tier drops out of the auto-playing set, but this catches the
  // remaining live ones when the whole app/hook unmounts.
  useEffect(() => {
    const intervals = intervalsRef.current
    return () => {
      for (const intervalId of intervals.values()) clearInterval(intervalId)
      intervals.clear()
    }
  }, [])
}
