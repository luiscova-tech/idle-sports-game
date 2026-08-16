import { useGameStore } from '../store/useGameStore'
import {
  createBaseballModule,
  BASEBALL_VENTURE_TIERS,
  scaledBaseballTiers,
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
  /** The parent tab's shared clock instant — threaded straight through to
   *  VentureCard, which needs it to decide whether this tier's auto-play has
   *  paused for inactivity. One clock per tab, not one per card. */
  nowMs: number
}

/** Thin store-wiring adapter around the fully generic VentureCard — the
 *  structurally-parallel twin of SoccerVentureCard, over baseballTiers/
 *  BASEBALL_VENTURE_TIERS/the baseball store actions instead. Deliberately
 *  does NOT read `legacy.prestigeCount`/isTierRevealed-style gating at all
 *  — baseball tiers exist independently of the reveal/prestige system for
 *  this validation slice (see CLAUDE.md's "Baseball" amendment), so there
 *  is no equivalent concept to wire up here. */
function BaseballVentureCard({ tierId, nowMs }: BaseballVentureCardProps) {
  const tierIndex = BASEBALL_VENTURE_TIERS.findIndex((c) => c.id === tierId)
  // The LIVE per-save-anchored config — NOT the raw BASEBALL_VENTURE_TIERS
  // reference — so every cost this card DISPLAYS (unlock/manager/training)
  // exactly matches what the store actually CHARGES (both derive from the
  // same scaledBaseballTiers helper, keyed on the same
  // baseballCostAnchorMultiplier). Using the raw reference here would show
  // a player baseball's original numbers while the store charged the
  // re-anchored ones — the exact display/charge mismatch this shared helper
  // exists to prevent. See CLAUDE.md's "Income-rate-anchored entry costs".
  const baseballCostAnchorMultiplier = useGameStore((s) => s.baseballCostAnchorMultiplier)
  const config = scaledBaseballTiers(baseballCostAnchorMultiplier)[tierIndex]
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
      // 'manual' is what exempts a player click from the
      // unattended-auto-play pause AND re-stamps this tier's inactivity
      // clock — see GameState.tickTier. useMatchTicker passes nothing here,
      // so its interval ticks default to 'auto'.
      onTick={() => tickBaseballTier(tierId, 'manual')}
      nowMs={nowMs}
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
