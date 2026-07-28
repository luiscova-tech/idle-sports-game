import { useGameStore } from '../store/useGameStore'
import {
  SOCCER_VENTURE_TIERS,
  DEFAULT_SOCCER_CONFIG,
  tierUpgradeCost,
  tierPerTickRevenue,
  trainingEffectMultiplier,
  nextMilestoneLevel,
  previousMilestoneLevel,
  getOutcome,
  getPerformanceFactor,
  matchOutcomeProbabilities,
} from '../sports/soccer/soccerModule'
import { calculateMatchRevenue, expectedMatchRevenue } from '../engine/economy'
import { unlockCostMultiplier, globalRevenueMultiplier } from '../engine/prestige'
import './VentureCard.css'

const OUTCOME_LABEL: Record<'win' | 'draw' | 'loss', string> = {
  win: 'WIN',
  draw: 'DRAW',
  loss: 'LOSS',
}

interface VentureCardProps {
  tierId: string
}

// One card per venture tier. Locked tiers show what's needed to unlock;
// unlocked tiers show their own independent match/level/manager state and
// controls — no cross-tier logic here, each card only reads/acts on its
// own tierId. Markup/CSS only below reflects card state (unlocked vs.
// locked-affordable vs. locked-far) — no store/logic changes.
function VentureCard({ tierId }: VentureCardProps) {
  const tierIndex = SOCCER_VENTURE_TIERS.findIndex((c) => c.id === tierId)
  const config = SOCCER_VENTURE_TIERS[tierIndex]
  const tier = useGameStore((s) => s.tiers[tierIndex])
  const revenue = useGameStore((s) => s.currencies.revenue)
  const legacy = useGameStore((s) => s.legacy)
  const tickTier = useGameStore((s) => s.tickTier)
  const upgradeTier = useGameStore((s) => s.upgradeTier)
  const hireManagerForTier = useGameStore((s) => s.hireManagerForTier)
  const unlockTier = useGameStore((s) => s.unlockTier)

  // Mirrors the exact rounding unlockTier()/tickTier() apply in the store,
  // so a Legacy "Veteran Discount"/"Revenue Boost" purchase is reflected
  // here the instant it's bought — never a display that could drift from
  // what the store actually charges/grants (same principle as the
  // match-projected-payout preview below).
  const legacyUnlockMultiplier = unlockCostMultiplier(legacy.permanentUpgrades)
  const legacyRevenueMultiplier = globalRevenueMultiplier(legacy.permanentUpgrades)

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
        <button
          type="button"
          className="btn btn--unlock"
          onClick={() => unlockTier(tierId)}
          disabled={!unlockAffordable}
        >
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
  // the exact same getOutcome()/getPerformanceFactor()/calculateMatchRevenue()
  // the engine uses at real match completion — never a separate formula
  // that could drift. Once this match's first tick has run, its outcome is
  // already resolved (see soccerModule.ts's resolveMatchOutcome) and these
  // two calls just read that back out — no store/economy logic changes; the
  // actual payout still only lands when the match genuinely completes.
  //
  // `currentOutcome` is the SINGLE authoritative read of this tier's
  // CURRENT (in-progress or freshly-started) match's outcome — every place
  // in this card that displays "what's this match's outcome" (the live pill
  // next to the score, and the projection line) reads this exact same
  // value, never a second independent computation. Before this fix, the
  // pill next to the score instead showed `tier.lastOutcome` — the
  // PREVIOUS match's cached result, a genuinely different value from a
  // genuinely different match, displayed immediately adjacent to the
  // CURRENT match's live score. That's not a bug in either value
  // individually (both were internally correct for what they represented),
  // but showing them side by side, with nothing distinguishing "last
  // match's result" from "this match's live status," read as an
  // inconsistency to a player watching the score. `tier.lastOutcome` is
  // still shown below (see the stats row) — clearly labeled as history,
  // not live status.
  const progressPercent = Math.round(
    (tier.match.elapsedTicks / DEFAULT_SOCCER_CONFIG.ticksPerMatch) * 100,
  )
  // A freshly-reset match (elapsedTicks === 0, right after completion or a
  // brand-new unlock) has no resolved outcome yet, and getOutcome()'s
  // fallback for that case (tie-break on a 0-0 raw score) resolves to
  // 'draw' — correct as a fallback for a genuinely-unresolvable state, but
  // actively misleading if shown as a live result for a match that hasn't
  // had a single tick, adversarially found to flash a spurious "DRAW" badge
  // (with a real-looking flat-draw payout projection) on every single
  // match completion and every fresh tier unlock. matchStarted gates the
  // projection line's payout number (still meaningful pre-resolution-word,
  // see below); the actual live outcome WORD is gated separately by
  // matchComplete (display-timing only — see next comment).
  const matchStarted = tier.match.elapsedTicks > 0
  // Display-timing only: the OUTCOME WORD (WIN/DRAW/LOSS) is deliberately
  // withheld until the match has actually run its full length, even though
  // the underlying result is already decided at kickoff (resolvedOutcome,
  // resolved on tick 0 — see soccerModule.ts). This does NOT change what's
  // computed/stored anywhere; `currentOutcome`/`currentPerformanceFactor`
  // below are still the single, authoritative read used everywhere a word
  // or number is shown — matchComplete only gates whether the WORD is
  // rendered, never a second/divergent computation of it.
  //
  // Note: because tickTier() (useGameStore.ts) resets a tier's match to
  // createInitialState() in the SAME set() call that finalizes a completed
  // match (the finishing tick's own elapsedTicks===ticksPerMatch state is
  // only ever used transiently, to compute the outcome/payout, and is never
  // itself written into the store), a rendered frame with
  // elapsedTicks===ticksPerMatch essentially never occurs in live play — a
  // match's visible elapsedTicks jumps straight from ticksPerMatch-1 to a
  // fresh 0. matchComplete is still computed correctly here (rather than
  // hardcoded false) so the word displays correctly if that ever changes,
  // but in today's UI its practical effect is "the live word never shows
  // during this match" — the just-finished result remains visible via the
  // separate, always-on "Last Result" stat below (tier.lastOutcome),
  // exactly as before this change.
  const matchComplete = tier.match.elapsedTicks >= DEFAULT_SOCCER_CONFIG.ticksPerMatch
  const currentOutcome = getOutcome(tier.match)
  const currentPerformanceFactor = getPerformanceFactor(tier.match)
  const projectedPayout = Math.round(
    calculateMatchRevenue(currentOutcome, currentPerformanceFactor) *
      config.baseRevenueMultiplier *
      trainingEffectMultiplier(tier.level) *
      legacyRevenueMultiplier,
  )

  // IN-PROGRESS payout preview only (used below when matchStarted &&
  // !matchComplete) — deliberately NOT derived from currentOutcome/
  // currentPerformanceFactor above, unlike projectedPayout. Those two are
  // reads of this match's ALREADY-RESOLVED result (see soccerModule.ts's
  // resolveMatchOutcome, decided once at kickoff) — showing a number built
  // from them, even with the outcome WORD hidden, would let a sharp player
  // infer the real result from the number alone (e.g. it jumping to the
  // flat loss payout the instant the match starts). expectedPayout instead
  // is a genuine expected value over the three possible outcomes, computed
  // ONLY from information already visible before resolution ever mattered:
  // this tier's CURRENT training level (tier.level, read live — reflects a
  // mid-match "Improve Training" purchase immediately) and this match's
  // OWN already-drawn opponent level (tier.match.opponentLevel, the exact
  // number already shown by the "Facing a Level N opponent" line below —
  // reusing it here reveals nothing new). matchOutcomeProbabilities/
  // expectedMatchRevenue are pure functions of those inputs alone — they
  // never read resolvedOutcome/resolvedMargin/homeScore/awayScore — so by
  // construction this number is IDENTICAL for every match with the same
  // level/opponent, no matter what that match actually rolls. See
  // CLAUDE.md for the verification proving this (many matches, same
  // inputs, provably identical expected-payout output regardless of the
  // real resolved outcome).
  //
  // Falls back to projectedPayout only in the one case where an opponent
  // level was never drawn at all: a match already mid-flight under the OLD
  // pre-probability-model schema (persisted before that model existed,
  // gated on tickIndex===0 in tick() — see the fourteenth amendment). Such
  // a match has no "hidden resolved outcome" to leak in the first place —
  // its result is just whatever its live score currently is — so there's
  // no downside to showing its real live projection instead of an
  // expected value there's no opponent level to compute one from.
  const expectedPayout =
    tier.match.opponentLevel !== undefined
      ? Math.round(
          expectedMatchRevenue(matchOutcomeProbabilities(tier.level, tier.match.opponentLevel)) *
            config.baseRevenueMultiplier *
            trainingEffectMultiplier(tier.level) *
            legacyRevenueMultiplier,
        )
      : projectedPayout

  return (
    <div className="venture-card venture-card--unlocked" data-tier-id={tierId}>
      <div className="venture-card__header">
        <div className="venture-card__title-group">
          <span className="venture-card__tier-icon" aria-hidden="true">
            {config.icon}
          </span>
          <h3 className="venture-card__title">{config.name}</h3>
        </div>
        {tier.managerHired && <span className="venture-card__badge">AUTO</span>}
      </div>

      <div className="venture-card__score">
        {tier.match.homeScore} - {tier.match.awayScore}
        <span className="venture-card__clock">{tier.match.elapsedTicks}'</span>
        {matchComplete && (
          <span className={`venture-card__outcome-badge venture-card__outcome-badge--${currentOutcome}`}>
            {OUTCOME_LABEL[currentOutcome]}
          </span>
        )}
      </div>

      <div className="venture-card__progress-track">
        <div className="venture-card__progress-fill" style={{ width: `${progressPercent}%` }} />
      </div>
      {/* A payout NUMBER stays visible throughout — it has real decision
          value when managing several auto-playing tiers at once — but the
          outcome WORD is withheld until matchComplete (see above). Three
          states:
            - not yet started: no number to show yet (kickoff pending) —
              reads as "N/A", not a possibly-misleading number derived from
              the pre-resolution fallback outcome.
            - in progress: expectedPayout (see its own doc comment above) —
              a genuine expected value that cannot correlate with the
              already-resolved outcome, labeled "Expected" (not
              "Projected") and prefixed with "~" so it reads honestly as an
              estimate rather than a resolved number.
            - complete: unchanged from before this session — the real
              resolved word + projectedPayout (the actual payout this match
              will pay), both from the single currentOutcome/
              currentPerformanceFactor source, never a second/divergent one. */}
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
        <button type="button" className="btn btn--primary" onClick={() => tickTier(tierId)}>
          Push the Attack
        </button>
        <p className="venture-card__per-push">+{perTickRevenue} Revenue per push</p>

        <button
          type="button"
          className="btn btn--purchase"
          onClick={() => upgradeTier(tierId)}
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
          <p className="venture-card__auto-note">Manager hired — auto-advancing.</p>
        ) : (
          <button
            type="button"
            className="btn btn--purchase"
            onClick={() => hireManagerForTier(tierId)}
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
