import { useEffect } from 'react'
import { useGameStore } from '../store/useGameStore'
import { SOCCER_TICK_INTERVAL_MS } from '../sports/soccer/soccerModule'

/**
 * Owns the idle loop's timer. This is the only place in the codebase where
 * a setInterval exists — the engine and store stay timer-free and
 * synchronously testable. Takes intervalMs as a parameter so future sports
 * can pass their own pacing without changing this hook. Only runs once
 * autoPlayUnlocked is true (see MatchControls' "Hire a Manager" purchase) —
 * before that, matches only advance via manual "Push the Attack" clicks.
 */
export function useMatchTicker(intervalMs: number = SOCCER_TICK_INTERVAL_MS) {
  const tick = useGameStore((s) => s.tick)
  const autoPlayUnlocked = useGameStore((s) => s.autoPlayUnlocked)

  useEffect(() => {
    if (!autoPlayUnlocked) return
    const id = setInterval(tick, intervalMs)
    return () => clearInterval(id)
  }, [tick, intervalMs, autoPlayUnlocked])
}
