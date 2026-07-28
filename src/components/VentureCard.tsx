import { useGameStore } from '../store/useGameStore'
import {
  SOCCER_VENTURE_TIERS,
  DEFAULT_SOCCER_CONFIG,
  tierUpgradeCost,
  tierPerTickRevenue,
  getOutcome,
} from '../sports/soccer/soccerModule'
import { calculateMatchRevenue } from '../engine/economy'
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

  // Purely presentational: derived from state already in the store, using
  // the exact same getOutcome()/calculateMatchRevenue() the engine uses at
  // real match completion — never a separate formula that could drift.
  // No store/economy logic changes; the actual payout still only lands
  // when the match genuinely completes.
  const progressPercent = Math.round(
    (tier.match.elapsedTicks / DEFAULT_SOCCER_CONFIG.ticksPerMatch) * 100,
  )
  const projectedOutcome = getOutcome(tier.match)
  const projectedPayout = Math.round(
    calculateMatchRevenue(projectedOutcome) * config.baseRevenueMultiplier * tier.level * legacyRevenueMultiplier,
  )

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
        {tier.lastOutcome && (
          <span
            className={`venture-card__last-result venture-card__last-result--${tier.lastOutcome}`}
          >
            {OUTCOME_LABEL[tier.lastOutcome]}
          </span>
        )}
      </div>

      <div className="venture-card__progress-track">
        <div className="venture-card__progress-fill" style={{ width: `${progressPercent}%` }} />
      </div>
      <p className="venture-card__projection">
        If the match ended now: <strong>{OUTCOME_LABEL[projectedOutcome]}</strong>, +
        {projectedPayout} Revenue
      </p>

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
