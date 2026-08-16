import { useEffect, useRef, useState } from 'react'
import { useGameStore } from '../store/useGameStore'
import { autoTickIntervalMsForTier, isAutoPlayPaused } from '../engine/ventureTiers'
import { SOCCER_VENTURE_TIERS } from '../sports/soccer/soccerModule'
import { BASEBALL_VENTURE_TIERS } from '../sports/baseball/baseballModule'

/**
 * How often a SCREEN re-evaluates the unattended-auto-play pause boundary for
 * DISPLAY.
 *
 * This is a polling cadence, so it is also an honest upper bound on display
 * lag: a tier that crosses the threshold is paused in the store immediately
 * (that guard reads the clock itself, on every tick), but its card can keep
 * showing "AUTO" for up to this long before repainting as "PAUSED". 15
 * seconds against a four-HOUR threshold makes that window imperceptible while
 * costing only a few re-renders a minute, confined to the tab that owns the
 * clock. Nothing about CORRECTNESS rests on it — an adversarial review
 * correctly caught an earlier comment here claiming the card and the store
 * "can never disagree", which a polled clock cannot guarantee.
 */
export const AUTO_PLAY_PAUSE_CHECK_MS = 15_000

/**
 * A shared, coarse "what time is it" clock for anything that has to notice a
 * time boundary passing while the rest of the app sits still.
 *
 * Exists because this project's time-based logic takes `nowMs` as an explicit
 * PARAMETER (the pattern established by the Daily/Weekly objectives work) —
 * which makes those functions testable, but also means SOMETHING has to
 * supply a moving value or a boundary would only ever be noticed on an
 * unrelated re-render. This is that something, in one place, so the two
 * consumers (the auto-play pause and the Objectives countdowns) can't drift
 * into two different ad-hoc intervals.
 *
 * Display/derivation only: it writes no store state, so it can never grant,
 * persist or advance anything by itself.
 */
export function useNowMs(intervalMs: number): number {
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return nowMs
}

/**
 * Owns the idle loop's timers — the only setIntervals in the codebase. Each
 * auto-playing tier gets its OWN interval at its OWN real-world pace (see
 * autoTickIntervalMsForTier — higher tiers auto-tick meaningfully slower),
 * rather than one shared interval ticking every tier identically. A manual
 * click never goes through this hook at all — it calls tickTier()/
 * tickBaseballTier() directly from the relevant VentureCard adapter — so
 * manual play always resolves instantly regardless of tier, unaffected by
 * any of these intervals.
 *
 * Generalized to cover BOTH sports (see CLAUDE.md's "Baseball" amendment)
 * — each sport's auto-playing tier ids are diffed and interval-managed
 * completely independently via `syncSportIntervals` below, keyed by a
 * `sport:tierId` composite so the two sports' interval-map entries can
 * never collide even if a future sport happened to reuse a tier id string.
 *
 * Intervals are tracked in a ref, keyed this way, and only ADDED/REMOVED as
 * a diff against the current auto-playing set — never blanket torn down
 * and recreated. That distinction matters now that tiers have wildly
 * different intervals (600ms to ~17s+): an earlier version recreated EVERY
 * interval whenever the SET of auto-tiers changed at all, so hiring a
 * manager for a brand-new low tier would reset a high tier's in-flight
 * countdown back to zero — with a long enough interval and frequent enough
 * manager hires, a high tier's auto-play could be perpetually restarted
 * before ever firing. Diffing means an unrelated tier's timer is never
 * touched by another tier's (or another SPORT's) manager-hire/unlock/lock
 * event.
 */
export function useMatchTicker() {
  const tickTier = useGameStore((s) => s.tickTier)
  const tickBaseballTier = useGameStore((s) => s.tickBaseballTier)
  // Stable, order-preserving keys so the effect only re-diffs when the SET
  // of auto-playing tiers changes — not on every match tick (which would
  // otherwise re-diff on every score change).
  // Paused tiers are dropped from the interval set so their timers are torn
  // down rather than left firing no-ops.
  //
  // `Date.now()` is read INSIDE the selector rather than from a `useNowMs`
  // state clock, deliberately. This hook is mounted in App.tsx, above every
  // screen, so a state clock here would re-render the ENTIRE app tree on a
  // fixed interval forever — a real cost this hook previously never imposed,
  // and one that buys nothing, because CORRECTNESS does not live here: the
  // store's own guard inside tickTier/tickBaseballTier is authoritative and
  // consults the clock itself on every tick. This filter is opportunistic
  // cleanup only. (Caught by adversarial review, which flagged both the
  // app-wide re-render and that a third clock instance was being spun up
  // here while claiming to "share" one.)
  //
  // The consequence, stated plainly: these selectors re-run on every store
  // change, so a tier that crosses the pause boundary loses its interval on
  // the next store change — continuous while ANY tier is still running, and
  // never, once every tier has paused. That last case is exactly the one
  // where it does not matter: the surviving intervals fire into the store's
  // guard and do nothing at all.
  const soccerAutoTierKey = useGameStore((s) =>
    s.tiers
      .filter((t) => t.unlocked && t.managerHired && !isAutoPlayPaused(t, Date.now()))
      .map((t) => t.id)
      .join(','),
  )
  const baseballAutoTierKey = useGameStore((s) =>
    s.baseballTiers
      .filter((t) => t.unlocked && t.managerHired && !isAutoPlayPaused(t, Date.now()))
      .map((t) => t.id)
      .join(','),
  )

  const intervalsRef = useRef(new Map<string, ReturnType<typeof setInterval>>())

  useEffect(() => {
    const intervals = intervalsRef.current

    /** Diffs one sport's currently-auto-playing tier ids against the
     *  interval map, adding/removing only what actually changed for THIS
     *  sport's own namespaced keys — called once per sport below, never
     *  touching the other sport's entries. */
    function syncSportIntervals(
      sportKey: string,
      autoTierIdsCsv: string,
      tierConfigs: { id: string }[],
      tick: (tierId: string) => void,
    ) {
      const activeIds = new Set(autoTierIdsCsv ? autoTierIdsCsv.split(',') : [])

      for (const [key, intervalId] of intervals) {
        if (!key.startsWith(`${sportKey}:`)) continue
        const tierId = key.slice(sportKey.length + 1)
        if (!activeIds.has(tierId)) {
          clearInterval(intervalId)
          intervals.delete(key)
        }
      }

      for (const tierId of activeIds) {
        const key = `${sportKey}:${tierId}`
        if (intervals.has(key)) continue
        const tierIndex = tierConfigs.findIndex((c) => c.id === tierId)
        const intervalMs = autoTickIntervalMsForTier(tierIndex)
        intervals.set(key, setInterval(() => tick(tierId), intervalMs))
      }
    }

    syncSportIntervals('soccer', soccerAutoTierKey, SOCCER_VENTURE_TIERS, tickTier)
    syncSportIntervals('baseball', baseballAutoTierKey, BASEBALL_VENTURE_TIERS, tickBaseballTier)
  }, [tickTier, tickBaseballTier, soccerAutoTierKey, baseballAutoTierKey])

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

/**
 * How often the Daily/Weekly boundary check wakes up. 30 seconds is chosen
 * against what it is actually watching: a calendar-day rollover and a 7-day
 * rolling window. A player crossing local midnight with the app open sees
 * their new daily within half a minute — imperceptible against a 24-hour
 * period — and the wake-up itself is close to free, because
 * `refreshPeriodicObjectives` bails before touching any real work (or any
 * `set()`, and therefore any localStorage write) whenever no boundary has
 * passed, which is essentially always.
 */
const PERIODIC_OBJECTIVE_CHECK_MS = 30_000

/**
 * How often the app announces that it is still alive. Must stay comfortably
 * BELOW `CLOSED_GAP_THRESHOLD_MS` (2min), since a gap larger than that is what
 * the store reads as "the app was not running" — 30s leaves a 4x margin, wide
 * enough that ordinary background-tab timer throttling can never be mistaken
 * for a closure.
 */
const APP_HEARTBEAT_MS = 30_000

/**
 * Keeps `lastSeenMs` current so the unattended-auto-play pause counts only
 * time the app was actually OPEN.
 *
 * Without this the threshold is raw wall clock, and since this game has no
 * offline progress, a player who closed the tab overnight returned to find
 * every managed tier paused over hours in which auto-play never ran — a
 * behaviour adversarial review reproduced across two processes, and which the
 * owner chose to change. The store action credits any detected closure back to
 * every tier.
 *
 * Fires IMMEDIATELY on mount, before any tick can happen: the credit has to
 * land before `useMatchTicker`'s intervals start firing, or the first ticks
 * after a long closure would be judged against un-credited stamps. Mounted
 * first in App.tsx for the same reason — effects run in declaration order, and
 * this one must win.
 */
export function useAppHeartbeat() {
  const recordAppHeartbeat = useGameStore((s) => s.recordAppHeartbeat)

  useEffect(() => {
    recordAppHeartbeat()
    const id = setInterval(recordAppHeartbeat, APP_HEARTBEAT_MS)
    return () => clearInterval(id)
  }, [recordAppHeartbeat])
}

/**
 * Drives the Daily/Weekly objective boundary check off the wall clock.
 *
 * Lives in this file, alongside the idle loop, on purpose: CLAUDE.md's
 * standing convention is that this project's setIntervals live in exactly
 * ONE module, so a future session looking for "what runs on a timer here"
 * finds all of it in one place. It is a SEPARATE hook rather than more code
 * inside useMatchTicker because it watches something completely different
 * (the clock, not the tiers) at a completely different cadence, and must
 * keep running even when not a single tier is auto-playing — which is
 * precisely the case where it matters most, since with no managers hired
 * there are no ticks at all to notice a rollover.
 *
 * Mounted once in App.tsx, above every screen, for the same reason
 * useMatchTicker is: an idle game must not pause a timer because a menu is
 * open. It also fires once immediately on mount, so a player returning after
 * days away gets their fresh daily/weekly on the first frame rather than up
 * to 30 seconds later.
 */
export function usePeriodicObjectives() {
  const refreshPeriodicObjectives = useGameStore((s) => s.refreshPeriodicObjectives)

  useEffect(() => {
    refreshPeriodicObjectives()
    const intervalId = setInterval(refreshPeriodicObjectives, PERIODIC_OBJECTIVE_CHECK_MS)
    return () => clearInterval(intervalId)
  }, [refreshPeriodicObjectives])
}
