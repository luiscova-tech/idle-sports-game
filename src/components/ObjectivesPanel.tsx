import { useGameStore, selectObjectiveStats } from '../store/useGameStore'
import { objectiveProgress } from '../engine/objectives'
import './ObjectivesPanel.css'

/**
 * The Hub's Objectives section — a compact, at-a-glance list of the 2-3
 * currently-assigned short-term goals (see engine/objectives.ts and
 * CLAUDE.md's "Objectives" section).
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
 * `objectiveProgress`, the exact pure function the store judges completion
 * with, so what a player sees at 100% is precisely what the store pays out,
 * never a parallel estimate.
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
  const tiers = useGameStore((s) => s.tiers)
  const baseballTiers = useGameStore((s) => s.baseballTiers)
  const lifetimeStats = useGameStore((s) => s.lifetimeStats)
  const prestigeCount = useGameStore((s) => s.legacy.prestigeCount)

  if (objectives.length === 0) return null

  const stats = selectObjectiveStats(tiers, baseballTiers, lifetimeStats, prestigeCount)

  return (
    <section className="objectives" aria-label="Objectives">
      <h2 className="objectives__title">Objectives</h2>
      <ul className="objectives__list">
        {objectives.map((active) => {
          const progress = objectiveProgress(active, stats)
          if (!progress) return null
          return (
            <li className="objective" key={active.configId}>
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
        })}
      </ul>
    </section>
  )
}

export default ObjectivesPanel
