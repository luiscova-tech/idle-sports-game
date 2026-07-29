import { useGameStore } from '../store/useGameStore'
import {
  createBaseballModule,
  BASEBALL_VENTURE_TIERS,
  estimatedTicksForBaseballTier,
  type BaseballMatchState,
} from '../sports/baseball/baseballModule'
import { matchOutcomeProbabilitiesWithoutDrawTriple } from '../engine/winProbability'
import { unlockCostMultiplier, globalRevenueMultiplier } from '../engine/prestige'
import VentureCard from './VentureCard'

// Safe to construct a second instance here for the same reason
// SoccerVentureCard does — see that file's own comment.
const baseballModule = createBaseballModule()

function ordinalSuffix(n: number): string {
  const lastTwo = n % 100
  if (lastTwo >= 11 && lastTwo <= 13) return 'th'
  switch (n % 10) {
    case 1:
      return 'st'
    case 2:
      return 'nd'
    case 3:
      return 'rd'
    default:
      return 'th'
  }
}

function formatBaseballClock(match: BaseballMatchState): string {
  const half = match.half === 'top' ? 'Top' : 'Bot'
  return `${half} ${match.inning}${ordinalSuffix(match.inning)}, ${match.outs} out${match.outs === 1 ? '' : 's'}`
}

interface BaseballVentureCardProps {
  tierId: string
}

/** Thin store-wiring adapter around the fully generic VentureCard — the
 *  structurally-parallel twin of SoccerVentureCard, over baseballTiers/
 *  BASEBALL_VENTURE_TIERS/the baseball store actions instead. Deliberately
 *  does NOT read `legacy.prestigeCount`/isTierRevealed-style gating at all
 *  — baseball tiers exist independently of the reveal/prestige system for
 *  this validation slice (see CLAUDE.md's "Baseball" amendment), so there
 *  is no equivalent concept to wire up here. */
function BaseballVentureCard({ tierId }: BaseballVentureCardProps) {
  const tierIndex = BASEBALL_VENTURE_TIERS.findIndex((c) => c.id === tierId)
  const config = BASEBALL_VENTURE_TIERS[tierIndex]
  const tier = useGameStore((s) => s.baseballTiers[tierIndex])
  const revenue = useGameStore((s) => s.currencies.revenue)
  const legacy = useGameStore((s) => s.legacy)
  const tickBaseballTier = useGameStore((s) => s.tickBaseballTier)
  const upgradeBaseballTier = useGameStore((s) => s.upgradeBaseballTier)
  const hireManagerForBaseballTier = useGameStore((s) => s.hireManagerForBaseballTier)
  const unlockBaseballTier = useGameStore((s) => s.unlockBaseballTier)

  return (
    <VentureCard
      tierId={tierId}
      config={config}
      tier={tier}
      sportModule={baseballModule}
      revenue={revenue}
      legacyUnlockMultiplier={unlockCostMultiplier(legacy.permanentUpgrades)}
      legacyRevenueMultiplier={globalRevenueMultiplier(legacy.permanentUpgrades)}
      onTick={() => tickBaseballTier(tierId)}
      onUpgrade={() => upgradeBaseballTier(tierId)}
      onHireManager={() => hireManagerForBaseballTier(tierId)}
      onUnlock={() => unlockBaseballTier(tierId)}
      formatMatchClock={formatBaseballClock}
      actionLabel="Step Up to Bat"
      perTickCaptionSuffix="per at-bat"
      computeOutcomeProbabilities={matchOutcomeProbabilitiesWithoutDrawTriple}
      estimatedTicksPerMatch={estimatedTicksForBaseballTier(tierIndex)}
    />
  )
}

export default BaseballVentureCard
