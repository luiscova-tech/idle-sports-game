// ============================================================
// src/engine/prestige.ts
// Sport-agnostic "Reset for Legacy" (prestige) math. Like economy.ts, this
// is a single isolated home for currency math — Legacy Points only ever
// need a scalar "how much was earned this run," never any sport-specific
// data, so this file must never import from src/sports/**.
// ============================================================

/** Tuned via simulation against the soccer ladder (see CLAUDE.md "Prestige
 *  system" section for the numbers): a first-ever prestige typically
 *  represents 350k-1M total lifetime earnings, and this constant maps that
 *  range to ~50-100 Legacy Points — enough for one or two permanent
 *  upgrades on a first prestige, not the whole tree. */
const LEGACY_POINTS_SCALING_CONSTANT = 10

/** Legacy Points a "Reset for Legacy" would grant right now, given this
 *  run's total earnings (sum of every venture tier's cumulativeRevenue
 *  since the last reset, or since game start if never reset). Square-root
 *  scaling means early, cheap revenue counts more per-point than the huge
 *  numbers reached later — so points earned still climb across repeated
 *  prestiges without growing linearly with them. */
export function calculateLegacyPoints(totalEarnings: number): number {
  if (totalEarnings <= 0) return 0
  return Math.floor(Math.sqrt(totalEarnings) / LEGACY_POINTS_SCALING_CONSTANT)
}

/** Levels/ownership of every permanent upgrade. Persists across every
 *  future prestige reset — never zeroed by resetForLegacy(). */
export interface PermanentUpgradeLevels {
  revenueBoostLevel: number
  headStartCapital: boolean
  fastTrack: boolean
  veteranDiscountLevel: number
}

export function createInitialPermanentUpgrades(): PermanentUpgradeLevels {
  return {
    revenueBoostLevel: 0,
    headStartCapital: false,
    fastTrack: false,
    veteranDiscountLevel: 0,
  }
}

/** Static catalog of the 4 permanent upgrades Legacy Points buy. Kept small
 *  and simple per design brief. Effects are expressed generically (a
 *  revenue multiplier, a starting-capital amount, a count of pre-unlocked
 *  tiers, an unlock-cost discount) so this stays sport-agnostic — a second
 *  sport's venture ladder benefits from the same upgrades with zero changes
 *  here. */
/** Veteran Discount's asymptote (see unlockCostMultiplier below): the total
 *  discount approaches this fraction but can mathematically never reach it,
 *  at ANY level, however large — a hard correctness requirement, since a
 *  100% discount would make unlocking free and break the economy. Chosen
 *  as a generous-but-bounded ceiling: even an arbitrarily-many-times-
 *  prestiged player still pays at least 25% of a tier's listed unlock cost. */
const VETERAN_DISCOUNT_MAX_TOTAL_DISCOUNT = 0.75
/** Each additional level closes 10% of the REMAINING gap to the asymptote
 *  above (not 10% of the original cost) — this is what makes the approach
 *  continuous and safe rather than a hard cutoff: every level still does
 *  *something*, just an ever-shrinking something, forever. */
const VETERAN_DISCOUNT_APPROACH_RATE = 0.9

/** Static catalog of the 4 permanent upgrades Legacy Points buy. Kept small
 *  and simple per design brief. Effects are expressed generically (a
 *  revenue multiplier, a starting-capital amount, a count of pre-unlocked
 *  tiers, an unlock-cost discount) so this stays sport-agnostic — a second
 *  sport's venture ladder benefits from the same upgrades with zero changes
 *  here.
 *
 *  Revenue Boost and Veteran Discount are deliberately uncapped (no
 *  `maxLevel`) — see globalRevenueMultiplier/unlockCostMultiplier below for
 *  why each is safe to scale indefinitely. Head Start Capital and Fast
 *  Track stay one-time toggles, unchanged. */
export const PERMANENT_UPGRADES = {
  revenueBoost: {
    label: 'Revenue Boost',
    description:
      '+10% Revenue from every tier, every run, forever. No level cap — an economic soft cap ' +
      'instead: cost keeps climbing every level, forever, so it self-limits without an artificial ceiling.',
    effectPerLevel: 0.1,
    costForLevel: (nextLevel: number) => 20 * nextLevel,
  },
  headStartCapital: {
    label: 'Head Start Capital',
    description: 'Every future run starts with 500 Revenue already banked.',
    amount: 500,
    cost: 15,
  },
  fastTrack: {
    label: 'Fast Track',
    description: 'The Corner Kick Cup starts pre-unlocked on every future run.',
    tiersPreUnlocked: 1,
    cost: 40,
  },
  veteranDiscount: {
    label: 'Veteran Discount',
    description:
      `Discounts every tier's unlock cost, every run, forever. Approaches but can never reach ` +
      `${Math.round(VETERAN_DISCOUNT_MAX_TOTAL_DISCOUNT * 100)}% off, no matter how many levels bought.`,
    costForLevel: (nextLevel: number) => 35 * nextLevel,
  },
} as const

/** Global multiplier applied on top of every tier's own multiplier/level —
 *  stacks additively per Revenue Boost level, forever (level 50 = +500%). */
export function globalRevenueMultiplier(levels: PermanentUpgradeLevels): number {
  return 1 + levels.revenueBoostLevel * PERMANENT_UPGRADES.revenueBoost.effectPerLevel
}

/**
 * Multiplier applied to every tier's configured unlockCost. Formula:
 *   multiplier(level) = (1 - MAX) + MAX * RATE^level
 * i.e. the discount itself is `MAX * (1 - RATE^level)`, asymptotically
 * approaching MAX (75%) as level grows, via a strictly-increasing-but-
 * ever-shrinking step each level (RATE^level shrinks geometrically but
 * never hits exactly zero for any finite level). The multiplier is
 * therefore always >= (1 - MAX) = 0.25 by construction — not because
 * RATE^level happens to stay positive in floating point, but because that
 * floor is added as its own fixed term. Even if RATE^level underflows to
 * exactly 0.0 at extreme levels, the multiplier still evaluates to exactly
 * (1 - MAX), never below it: the 100%-discount case is unreachable by
 * construction, not by floating-point luck. */
export function unlockCostMultiplier(levels: PermanentUpgradeLevels): number {
  const floor = 1 - VETERAN_DISCOUNT_MAX_TOTAL_DISCOUNT
  return floor + VETERAN_DISCOUNT_MAX_TOTAL_DISCOUNT * VETERAN_DISCOUNT_APPROACH_RATE ** levels.veteranDiscountLevel
}

/** Revenue balance a fresh/reset run should start with. */
export function startingRevenue(levels: PermanentUpgradeLevels): number {
  return levels.headStartCapital ? PERMANENT_UPGRADES.headStartCapital.amount : 0
}

/** How many tiers (counting from the first) should start unlocked on a
 *  fresh/reset run. Always at least 1 (the first tier always starts
 *  unlocked, prestige or not). */
export function startingUnlockedTierCount(levels: PermanentUpgradeLevels): number {
  return levels.fastTrack ? 1 + PERMANENT_UPGRADES.fastTrack.tiersPreUnlocked : 1
}
