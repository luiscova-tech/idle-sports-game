import { useGameStore } from '../store/useGameStore'
import { createSoccerModule, SOCCER_VENTURE_TIERS, type SoccerMatchState } from '../sports/soccer/soccerModule'
import { matchOutcomeProbabilities } from '../engine/winProbability'
import { unlockCostMultiplier, globalRevenueMultiplier } from '../engine/prestige'
import VentureCard from './VentureCard'

// A fresh SportModule instance is safe to construct here even though
// useGameStore.ts ALSO holds its own module-scoped instance — a
// SportModule is a stateless bundle of pure functions (all real match
// state lives in the store's own tier.match, passed in explicitly to every
// call), so there is no divergent "second copy of state" risk in having a
// second instance, only a second reference to the same pure behavior.
const soccerModule = createSoccerModule()

function formatSoccerClock(match: SoccerMatchState): string {
  return `${match.elapsedTicks}'`
}

interface SoccerVentureCardProps {
  tierId: string
}

/** Thin store-wiring adapter around the fully generic VentureCard — the
 *  only place that knows "this card is a soccer one specifically." See
 *  BaseballVentureCard for the parallel adapter. */
function SoccerVentureCard({ tierId }: SoccerVentureCardProps) {
  const tierIndex = SOCCER_VENTURE_TIERS.findIndex((c) => c.id === tierId)
  const config = SOCCER_VENTURE_TIERS[tierIndex]
  const tier = useGameStore((s) => s.tiers[tierIndex])
  const revenue = useGameStore((s) => s.currencies.revenue)
  const legacy = useGameStore((s) => s.legacy)
  const tickTier = useGameStore((s) => s.tickTier)
  const upgradeTier = useGameStore((s) => s.upgradeTier)
  const hireManagerForTier = useGameStore((s) => s.hireManagerForTier)
  const unlockTier = useGameStore((s) => s.unlockTier)

  return (
    <VentureCard
      tierId={tierId}
      config={config}
      tier={tier}
      sportModule={soccerModule}
      revenue={revenue}
      legacyUnlockMultiplier={unlockCostMultiplier(legacy.permanentUpgrades)}
      legacyRevenueMultiplier={globalRevenueMultiplier(legacy.permanentUpgrades)}
      onTick={() => tickTier(tierId)}
      onUpgrade={() => upgradeTier(tierId)}
      onHireManager={() => hireManagerForTier(tierId)}
      onUnlock={() => unlockTier(tierId)}
      formatMatchClock={formatSoccerClock}
      actionLabel="Push the Attack"
      perTickCaptionSuffix="per push"
      computeOutcomeProbabilities={matchOutcomeProbabilities}
    />
  )
}

export default SoccerVentureCard
