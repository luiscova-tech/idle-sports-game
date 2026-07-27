import { useGameStore } from '../store/useGameStore'
import {
  SOCCER_VENTURE_TIERS,
  DEFAULT_SOCCER_CONFIG,
  tierUpgradeCost,
  tierPerTickRevenue,
  getOutcome,
} from '../sports/soccer/soccerModule'
import { calculateMatchRevenue } from '../engine/economy'

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
// own tierId.
function VentureCard({ tierId }: VentureCardProps) {
  const tierIndex = SOCCER_VENTURE_TIERS.findIndex((c) => c.id === tierId)
  const config = SOCCER_VENTURE_TIERS[tierIndex]
  const tier = useGameStore((s) => s.tiers[tierIndex])
  const priorCumulativeRevenue = useGameStore((s) =>
    tierIndex > 0 ? s.tiers[tierIndex - 1].cumulativeRevenue : 0,
  )
  const revenue = useGameStore((s) => s.currencies.revenue)
  const tickTier = useGameStore((s) => s.tickTier)
  const upgradeTier = useGameStore((s) => s.upgradeTier)
  const hireManagerForTier = useGameStore((s) => s.hireManagerForTier)

  if (!tier.unlocked) {
    const priorTierName = SOCCER_VENTURE_TIERS[tierIndex - 1].name
    return (
      <div data-tier-id={tierId}>
        <h3>{config.name} — Locked</h3>
        <p>
          Unlocks when {priorTierName} earns {config.unlockThreshold} cumulative Revenue
          (currently {priorCumulativeRevenue}).
        </p>
      </div>
    )
  }

  const upgradeCost = tierUpgradeCost(config, tier.level)
  const perTickRevenue = tierPerTickRevenue(config, tier.level)

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
    calculateMatchRevenue(projectedOutcome) * config.baseRevenueMultiplier * tier.level,
  )

  return (
    <div data-tier-id={tierId}>
      <h3>{config.name}</h3>
      <p>
        {tier.match.homeScore} - {tier.match.awayScore} (Match clock: {tier.match.elapsedTicks}')
      </p>
      <progress value={tier.match.elapsedTicks} max={DEFAULT_SOCCER_CONFIG.ticksPerMatch} />
      <p>Match progress: {progressPercent}%</p>
      <p>
        If the match ended now ({OUTCOME_LABEL[projectedOutcome]}): {projectedPayout} Revenue
      </p>
      <p>Level: {tier.level}</p>
      <p>Matches completed: {tier.matchesCompleted}</p>
      <p>Cumulative Revenue: {tier.cumulativeRevenue}</p>
      {tier.lastOutcome && <p>Last result: {OUTCOME_LABEL[tier.lastOutcome]}</p>}

      <button type="button" onClick={() => tickTier(tierId)}>
        Push the Attack
      </button>
      <p>+{perTickRevenue} Revenue per push</p>

      <button
        type="button"
        onClick={() => upgradeTier(tierId)}
        disabled={revenue < upgradeCost}
      >
        Improve Training ({Math.min(revenue, upgradeCost)}/{upgradeCost} Revenue)
      </button>

      {tier.managerHired ? (
        <p>Manager hired — auto-advancing.</p>
      ) : (
        <button
          type="button"
          onClick={() => hireManagerForTier(tierId)}
          disabled={revenue < config.managerHireCost}
        >
          Hire a Manager ({Math.min(revenue, config.managerHireCost)}/{config.managerHireCost} Revenue)
        </button>
      )}
    </div>
  )
}

export default VentureCard
