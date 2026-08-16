import { useEffect, useState } from 'react'
import { useGameStore, selectObjectiveStats } from '../store/useGameStore'
import {
  objectiveProgress,
  periodicObjectiveConfigById,
  periodicObjectiveProgress,
  msUntilPeriodReset,
  type ObjectiveProgress,
  type PeriodicObjectiveKind,
  type PeriodicObjectiveState,
} from '../engine/objectives'
import './ObjectivesPanel.css'

/**
 * The Hub's Objectives section — a compact, at-a-glance list of the 2-3
 * currently-assigned short-term goals, followed by the single Daily and
 * single Weekly objective (see engine/objectives.ts and CLAUDE.md's
 * "Objectives" section).
 *
 * All three tiers live in ONE card rather than separate areas: they are the
 * same kind of thing at three time horizons, and a player should be able to
 * see everything they could be working toward in a single glance without
 * scrolling or switching anything.
 *
 * Rendered on the Hub itself, alongside the three building cards, NOT as a
 * fourth building and not inside Franchise HQ: the whole point is a
 * zero-friction glance on the screen the player already lands on every time.
 *
 * ── SHARED-DERIVATION RULE (same rule the Hub's building cards follow) ──
 * Every number here comes from state the store ALREADY tracks, run through
 * the SAME shared derivations used elsewhere — no stat is recomputed a
 * second way for this panel. `selectObjectiveStats` (exported by the store)
 * is the ONE place the objective stats record is assembled, and the store's
 * own tick path — the code that actually grants completions — builds its
 * record from that identical function. Progress itself is
 * `objectiveProgress` / `periodicObjectiveProgress`, the exact pure
 * functions the store judges completion with, so what a player sees at 100%
 * is precisely what the store pays out, never a parallel estimate. The
 * countdowns come from `msUntilPeriodReset`, the same function whose
 * boundary rule decides when a slot actually redraws.
 *
 * The individual store fields are selected separately (rather than
 * selecting the assembled record) because that record is a fresh object on
 * every call — returning it straight from a zustand selector would make
 * this component re-render on literally every tick. Selecting the stable
 * underlying references and assembling locally is the same approach
 * AchievementsPanel already uses for its own stats record.
 */
function ObjectivesPanel() {
  const objectives = useGameStore((s) => s.objectives)
  const dailyObjective = useGameStore((s) => s.dailyObjective)
  const weeklyObjective = useGameStore((s) => s.weeklyObjective)
  const tiers = useGameStore((s) => s.tiers)
  const baseballTiers = useGameStore((s) => s.baseballTiers)
  const lifetimeStats = useGameStore((s) => s.lifetimeStats)
  const prestigeCount = useGameStore((s) => s.legacy.prestigeCount)

  // A display-only clock, and deliberately not part of the game loop: the
  // "resets in ..." countdowns would otherwise freeze at whatever they read
  // when the component last re-rendered for some other reason. It never
  // touches store state — the actual boundary crossing is owned by
  // usePeriodicObjectives (hooks/useMatchTicker.ts) — so nothing here can
  // grant, redraw, or persist anything. 30s matches that hook's own cadence
  // and is far finer than the coarse h/m granularity displayed.
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  const stats = selectObjectiveStats(tiers, baseballTiers, lifetimeStats, prestigeCount)

  return (
    <section className="objectives" aria-label="Objectives">
      <h2 className="objectives__title">Objectives</h2>

      {objectives.length > 0 && (
        <ul className="objectives__list">
          {objectives.map((active) => {
            const progress = objectiveProgress(active, stats)
            if (!progress) return null
            return <ObjectiveRow key={active.configId} progress={progress} />
          })}
        </ul>
      )}

      <PeriodicObjectiveSection
        kind="daily"
        label="Daily"
        state={dailyObjective}
        stats={stats}
        nowMs={nowMs}
      />
      <PeriodicObjectiveSection
        kind="weekly"
        label="Weekly"
        state={weeklyObjective}
        stats={stats}
        nowMs={nowMs}
      />
    </section>
  )
}

/** One progress row — shared by the rotating list and both periodic
 *  sections so a goal looks and reads the same wherever it appears. */
function ObjectiveRow({ progress }: { progress: ObjectiveProgress }) {
  return (
    <li className="objective">
      <div className="objective__row">
        <span className="objective__description">{progress.description}</span>
        <span className="objective__count">
          {Math.min(progress.current, progress.target).toLocaleString()} /{' '}
          {progress.target.toLocaleString()}
        </span>
      </div>
      <div className="objective__track">
        <div className="objective__fill" style={{ width: `${progress.percent}%` }} />
      </div>
    </li>
  )
}

/**
 * One Daily/Weekly section. Two states, mirroring the capped-completion
 * rule the store implements:
 *  - IN PROGRESS: the same row the rotating objectives use, plus a reward
 *    line (rewards are surfaced here but not for rotating objectives, since
 *    these are once-a-period commitments — knowing a weekly carries Legacy
 *    Points is the whole reason to prioritise it).
 *  - COMPLETED: an explicit "Completed" state with the time until this
 *    slot's own boundary, because unlike a rotating objective it does NOT
 *    redraw on completion. Saying when it comes back is what stops that
 *    reading as a bug.
 */
function PeriodicObjectiveSection({
  kind,
  label,
  state,
  stats,
  nowMs,
}: {
  kind: PeriodicObjectiveKind
  label: string
  state: PeriodicObjectiveState
  stats: Record<string, number>
  nowMs: number
}) {
  const active = state.objective
  const config = active ? periodicObjectiveConfigById(kind, active.configId) : undefined
  const progress = active ? periodicObjectiveProgress(kind, active, stats) : null
  const resetsIn = formatDuration(msUntilPeriodReset(kind, state, nowMs))

  return (
    <div className={`objectives__period objectives__period--${kind}`}>
      <div className="objectives__period-header">
        <span className="objectives__period-label">{label}</span>
        <span className="objectives__period-timer">Resets in {resetsIn}</span>
      </div>

      {state.completed || !progress || !config ? (
        <p className="objectives__period-done">
          {state.completed ? '✓ Completed — back in ' + resetsIn : 'Picking a new objective…'}
        </p>
      ) : (
        <ul className="objectives__list">
          <ObjectiveRow progress={progress} />
          <li className="objective__reward">
            Reward: ~{config.rewardIncomeRateSeconds}s of income
            {config.rewardLegacyPoints ? (
              <span className="objective__reward-legacy">
                {' '}
                + {config.rewardLegacyPoints} Legacy Points
              </span>
            ) : null}
          </li>
        </ul>
      )}
    </div>
  )
}

/** Coarse "2d 4h" / "5h 12m" / "8m" / "under a minute" formatting — the
 *  countdown only ever needs to answer "roughly how long until this comes
 *  back", so it deliberately stops at two units and never shows seconds
 *  ticking, which would imply a precision the 30s display clock doesn't have. */
function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000)
  if (totalMinutes < 1) return 'under a minute'
  const days = Math.floor(totalMinutes / (60 * 24))
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  return `${minutes}m`
}

export default ObjectivesPanel
