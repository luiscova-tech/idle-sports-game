import type { ReactNode } from 'react'
import type { SportModule, MatchOutcome } from '../engine/types'
import type { VentureTierConfig, VentureTierState } from '../engine/ventureTiers'
import { isMatchComplete } from '../engine/tickEngine'
import {
  tierUpgradeCost,
  tierPerTickRevenue,
  trainingEffectMultiplier,
  nextMilestoneLevel,
  previousMilestoneLevel,
  isAutoPlayPaused,
  UNATTENDED_AUTO_PLAY_PAUSE_MS,
} from '../engine/ventureTiers'
import { calculateMatchRevenue, expectedMatchRevenue } from '../engine/economy'
import './VentureCard.css'

const OUTCOME_LABEL: Record<'win' | 'draw' | 'loss', string> = {
  win: 'WIN',
  draw: 'DRAW',
  loss: 'LOSS',
}

/** The minimum shape any sport's match state must have for this card to
 *  render generically — score is common to every sport currently plugged
 *  in, and opponentLevel/elapsedTicks are the two fields the win-
 *  probability/expected-value preview and the pre-tick gate need. Anything
 *  MORE specific than this (soccer's minute clock, baseball's inning/half/
 *  outs) is rendered via the `formatMatchClock` prop instead, so this file
 *  itself never needs to say "goal" or "inning" — see soccerModule.ts's/
 *  baseballModule.ts's own top-of-file comments for that rule. */
interface MatchStateEssentials {
  elapsedTicks: number
  opponentLevel?: number
  homeScore: number
  awayScore: number
}

interface VentureCardProps<TState extends MatchStateEssentials> {
  tierId: string
  config: VentureTierConfig
  tier: VentureTierState<TState>
  sportModule: SportModule<TState>
  revenue: number
  legacyUnlockMultiplier: number
  legacyRevenueMultiplier: number
  onTick: () => void
  /**
   * Current wall-clock instant, supplied by the parent tab's shared
   * `useNowMs` clock rather than read here.
   *
   * Passed in for two reasons: it keeps this card's own rendering a pure
   * function of its props (this project's explicit-nowMs precedent), and it
   * means ONE clock ticks for a whole tab's worth of cards instead of each
   * card owning an interval. Used only to decide whether this tier's
   * auto-play has paused for inactivity — nothing else here depends on time.
   */
  nowMs: number
  onUpgrade: () => void
  onHireManager: () => void
  onUnlock: () => void
  /** Sport-specific "what's happening right now" text next to the score —
   *  soccer's running minute clock, baseball's inning/half/outs. The only
   *  place a sport's own vocabulary is allowed to leak into this otherwise
   *  fully generic card. */
  formatMatchClock: (match: TState) => string
  /** The manual per-tick action's button label ("Push the Attack" for
   *  soccer, a baseball-flavored equivalent for baseball) and the short
   *  caption under it describing what one tick is worth. */
  actionLabel: string
  perTickCaptionSuffix: string
  /**
   * This sport's OWN win/draw/loss probability distribution for a given
   * (playerLevel, opponentLevel) pair — used ONLY for the in-progress
   * "Expected payout" preview below. Deliberately a PROP, not a hardcoded
   * import of soccer's own matchOutcomeProbabilities: an earlier version of
   * this card imported that function directly, which is only correct for a
   * sport whose real resolution ALSO draws from the with-draw distribution.
   * Baseball has no draw state (resolveMatchOutcomeWithoutDraw,
   * baseballModule.ts) — feeding its match into the WITH-draw formula
   * produced a systematically wrong (understated) expected value for every
   * in-progress baseball match, caught by adversarial review. Each sport's
   * adapter (SoccerVentureCard/BaseballVentureCard) now supplies the exact
   * distribution ITS OWN tick()/getOutcome() actually resolves from, so
   * this generic card can never again silently assume one sport's
   * resolution shape for another.
   */
  computeOutcomeProbabilities: (playerLevel: number, opponentLevel: number) => Record<MatchOutcome, number>
  /**
   * Rough estimate of this SPECIFIC tier's expected ticks-to-complete, used
   * only to size the progress bar. Defaults to `sportModule.ticksPerMatch`
   * when omitted — correct for soccer (one fixed length for every tier) but
   * NOT for baseball, where a fixed module-level estimate calibrated
   * against one tier's inning count (see BASEBALL_ESTIMATED_TICKS_PER_MATCH)
   * made the progress bar read as barely-half-done at completion for the
   * shortest tier, or pinned at a false 100% for the last ~15% of the
   * longest tier's real duration (caught by adversarial review). Baseball's
   * adapter passes a real per-tier estimate instead.
   */
  estimatedTicksPerMatch?: number
}

// One card per venture tier, generic over ANY sport's SportModule<TState> —
// see CLAUDE.md's "Baseball" amendment (Build Order step 3: "second sport
// as a plugged-in module, validates engine abstraction"). Locked tiers show
// what's needed to unlock; unlocked tiers show their own independent
// match/level/manager state and controls — no cross-tier logic here, each
// card only reads/acts on its own tierId. All store access happens in the
// caller (Home.tsx) via the onTick/onUpgrade/onHireManager/onUnlock props —
// this file has zero direct useGameStore coupling, so it has no idea
// whether it's rendering a soccer tier or a baseball one beyond what its
// props tell it.
function VentureCard<TState extends MatchStateEssentials>({
  tierId,
  config,
  tier,
  sportModule,
  revenue,
  legacyUnlockMultiplier,
  legacyRevenueMultiplier,
  onTick,
  nowMs,
  onUpgrade,
  onHireManager,
  onUnlock,
  formatMatchClock,
  actionLabel,
  perTickCaptionSuffix,
  computeOutcomeProbabilities,
  estimatedTicksPerMatch,
}: VentureCardProps<TState>): ReactNode {
  if (!tier.unlocked) {
    const unlockCost = Math.round(config.unlockCost * legacyUnlockMultiplier)
    const unlockAffordable = revenue >= unlockCost
    const unlockProgressPercent = Math.min(100, Math.round((revenue / unlockCost) * 100))

    return (
      <div
        className={`venture-card venture-card--locked ${
          unlockAffordable ? 'venture-card--locked-affordable' : 'venture-card--locked-far'
        }`}
        data-tier-id={tierId}
      >
        <div className="venture-card__header">
          <div className="venture-card__title-group">
            <span className="venture-card__tier-icon" aria-hidden="true">
              {config.icon}
            </span>
            <h3 className="venture-card__title">{config.name}</h3>
          </div>
          <span className="venture-card__lock-icon" aria-hidden="true">
            🔒
          </span>
        </div>
        <div className="venture-card__locked-progress-track">
          <div
            className="venture-card__locked-progress-fill"
            style={{ width: `${unlockProgressPercent}%` }}
          />
        </div>
        <button type="button" className="btn btn--unlock" onClick={onUnlock} disabled={!unlockAffordable}>
          Unlock {config.name} ({Math.min(revenue, unlockCost)}/{unlockCost} Revenue)
        </button>
      </div>
    )
  }

  const upgradeCost = tierUpgradeCost(config, tier.level)
  const perTickRevenue = Math.round(tierPerTickRevenue(config, tier.level) * legacyRevenueMultiplier)
  const nextMilestone = nextMilestoneLevel(tier.level)
  // Progress SINCE the previous milestone (or level 1, if none crossed
  // yet) — not raw level over the next target. The latter looks right only
  // for the very first milestone; for every one after that it's misleadingly
  // pre-filled the instant the previous milestone is crossed (e.g. landing
  // on level 13 would read as 59% of the way to 22, despite zero training
  // purchased since the crossing that just happened).
  const previousMilestone = previousMilestoneLevel(tier.level)
  const milestoneProgressPercent = nextMilestone
    ? Math.min(
        100,
        Math.round(((tier.level - previousMilestone) / (nextMilestone - previousMilestone)) * 100),
      )
    : 100

  // Purely presentational: derived from state already in the store, using
  // the exact same sportModule.getOutcome()/getPerformanceFactor()/
  // calculateMatchRevenue() the engine uses at real match completion —
  // never a separate formula that could drift. `currentOutcome` is the
  // SINGLE authoritative read of this tier's CURRENT match's outcome, used
  // everywhere this card displays "what's this match's outcome" (see
  // CLAUDE.md's "Outcome-display consolidation" amendment for the bug this
  // prevents).
  const progressPercent = Math.min(
    100,
    Math.round((tier.match.elapsedTicks / (estimatedTicksPerMatch ?? sportModule.ticksPerMatch)) * 100),
  )
  const matchStarted = tier.match.elapsedTicks > 0
  // The single shared completion check (engine/tickEngine.ts) — correctly
  // authoritative whether this sport has a fixed ticksPerMatch (soccer) or
  // a genuinely variable match length driven by its own isMatchComplete
  // (baseball, see engine/types.ts's SportModule.isMatchComplete and
  // CLAUDE.md's "Baseball" amendment) — never a second, UI-only copy of
  // "is this match over" logic.
  const matchComplete = isMatchComplete(sportModule, tier.tickIndex, tier.match)
  const currentOutcome = sportModule.getOutcome(tier.match)
  const currentPerformanceFactor = sportModule.getPerformanceFactor(tier.match)
  const projectedPayout = Math.round(
    calculateMatchRevenue(currentOutcome, currentPerformanceFactor) *
      config.baseRevenueMultiplier *
      trainingEffectMultiplier(tier.level) *
      legacyRevenueMultiplier,
  )

  // IN-PROGRESS payout preview only — deliberately NOT derived from
  // currentOutcome/currentPerformanceFactor above (this match's ALREADY-
  // RESOLVED result). A genuine expected value over the three possible
  // outcomes instead, computed ONLY from this tier's CURRENT training
  // level and this match's OWN already-drawn opponent level — see
  // CLAUDE.md for the full "impossible to correlate with the real outcome"
  // verification. Falls back to projectedPayout only when opponentLevel was
  // never drawn (a legacy pre-migration match with no such concept).
  const expectedPayout =
    tier.match.opponentLevel !== undefined
      ? Math.round(
          expectedMatchRevenue(computeOutcomeProbabilities(tier.level, tier.match.opponentLevel)) *
            config.baseRevenueMultiplier *
            trainingEffectMultiplier(tier.level) *
            legacyRevenueMultiplier,
        )
      : projectedPayout

  // The SAME function the store's tick guard uses — so the two can never
  // disagree about the RULE. They can briefly disagree about the MOMENT: the
  // store reads the clock on every tick, while this reads the tab's polled
  // `nowMs`, so a tier that just crossed the threshold can still render as
  // "AUTO" for up to AUTO_PLAY_PAUSE_CHECK_MS before repainting. That window
  // is display-only (the tier really has stopped advancing the instant it
  // crossed) and is bounded at 15s against a 4-hour threshold. An earlier
  // version of this comment claimed the two "can never disagree", which an
  // adversarial review correctly called out as something a polled clock
  // cannot promise.
  const autoPlayPaused = isAutoPlayPaused(tier, nowMs)

  return (
    <div className="venture-card venture-card--unlocked" data-tier-id={tierId}>
      <div className="venture-card__header">
        <div className="venture-card__title-group">
          <span className="venture-card__tier-icon" aria-hidden="true">
            {config.icon}
          </span>
          <h3 className="venture-card__title">{config.name}</h3>
        </div>
        {tier.managerHired && (
          <span className={`venture-card__badge${autoPlayPaused ? ' venture-card__badge--paused' : ''}`}>
            {autoPlayPaused ? 'PAUSED' : 'AUTO'}
          </span>
        )}
      </div>

      <div className="venture-card__score">
        {tier.match.homeScore} - {tier.match.awayScore}
        <span className="venture-card__clock">{formatMatchClock(tier.match)}</span>
        {matchComplete && (
          <span className={`venture-card__outcome-badge venture-card__outcome-badge--${currentOutcome}`}>
            {OUTCOME_LABEL[currentOutcome]}
          </span>
        )}
      </div>

      <div className="venture-card__progress-track">
        <div className="venture-card__progress-fill" style={{ width: `${progressPercent}%` }} />
      </div>
      {/* A payout NUMBER stays visible throughout — real decision value
          when managing several auto-playing tiers at once — but the
          outcome WORD is withheld until matchComplete. Three states: not
          started (kickoff pending, no number), in progress (expectedPayout,
          no word), complete (the real resolved word + projectedPayout). */}
      {!matchStarted ? (
        <p className="venture-card__projection">Projected payout: N/A — kickoff pending</p>
      ) : matchComplete ? (
        <p className="venture-card__projection">
          If the match ended now: <strong>{OUTCOME_LABEL[currentOutcome]}</strong>, +
          {projectedPayout} Revenue
        </p>
      ) : (
        <p className="venture-card__projection">Expected payout: ~{expectedPayout} Revenue</p>
      )}
      {tier.match.opponentLevel !== undefined && (
        <p className="venture-card__opponent-note">Facing a Level {tier.match.opponentLevel} opponent</p>
      )}

      <div className="venture-card__stats">
        <div className="venture-card__stat">
          <span className="venture-card__stat-label">Level</span>
          <span className="venture-card__stat-value">{tier.level}</span>
        </div>
        <div className="venture-card__stat">
          <span className="venture-card__stat-label">Matches</span>
          <span className="venture-card__stat-value">{tier.matchesCompleted}</span>
        </div>
        <div className="venture-card__stat">
          <span className="venture-card__stat-label">Lifetime</span>
          <span className="venture-card__stat-value">{tier.cumulativeRevenue}</span>
        </div>
        {tier.lastOutcome && (
          <div className="venture-card__stat">
            <span className="venture-card__stat-label">Last Result</span>
            <span
              className={`venture-card__outcome-badge venture-card__outcome-badge--${tier.lastOutcome}`}
            >
              {OUTCOME_LABEL[tier.lastOutcome]}
            </span>
          </div>
        )}
      </div>

      <div className="venture-card__actions">
        <button type="button" className="btn btn--primary" onClick={onTick}>
          {actionLabel}
        </button>
        <p className="venture-card__per-push">
          +{perTickRevenue} Revenue {perTickCaptionSuffix}
        </p>

        <button
          type="button"
          className="btn btn--purchase"
          onClick={onUpgrade}
          disabled={revenue < upgradeCost}
        >
          Improve Training ({Math.min(revenue, upgradeCost)}/{upgradeCost} Revenue)
        </button>
        {nextMilestone && (
          <div className="venture-card__milestone">
            <span className="venture-card__milestone-label">
              Next: training 2x at Level {nextMilestone} ({tier.level}/{nextMilestone})
            </span>
            <div className="venture-card__milestone-track">
              <div
                className="venture-card__milestone-fill"
                style={{ width: `${milestoneProgressPercent}%` }}
              />
            </div>
          </div>
        )}

        {tier.managerHired ? (
          autoPlayPaused ? (
            <p className="venture-card__auto-note venture-card__auto-note--paused">
              ⏸ Auto-play paused — this tier ran {UNATTENDED_AUTO_PLAY_PAUSE_MS / 3_600_000} hours without you.
              Your manager and match progress are safe. Tap {actionLabel} to resume — that always works and
              costs nothing; buying anything on this tier resumes it too.
            </p>
          ) : (
            <p className="venture-card__auto-note">Manager hired — auto-advancing.</p>
          )
        ) : (
          <button
            type="button"
            className="btn btn--purchase"
            onClick={onHireManager}
            disabled={revenue < config.managerHireCost}
          >
            Hire a Manager ({Math.min(revenue, config.managerHireCost)}/{config.managerHireCost} Revenue)
          </button>
        )}
      </div>
    </div>
  )
}

export default VentureCard
