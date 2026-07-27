import { useEffect } from 'react'
import { useGameStore } from '../store/useGameStore'
import { SOCCER_TICK_INTERVAL_MS } from '../sports/soccer/soccerModule'

/**
 * Owns the idle loop's timer. This is the only place in the codebase where
 * a setInterval exists — the engine and store stay timer-free and
 * synchronously testable. Takes intervalMs as a parameter so future sports
 * can pass their own pacing without changing this hook.
 */
export function useMatchTicker(intervalMs: number = SOCCER_TICK_INTERVAL_MS) {
  const tick = useGameStore((s) => s.tick)

  useEffect(() => {
    const id = setInterval(tick, intervalMs)
    return () => clearInterval(id)
  }, [tick, intervalMs])
}
