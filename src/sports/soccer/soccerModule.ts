// ============================================================
// src/sports/soccer/soccerModule.ts
// Soccer-specific implementation of SportModule<SoccerMatchState>. This is
// the only file allowed to say "goal", "chance", "possession", or "shot".
// ============================================================

import type { SportModule, TickResult, MatchOutcome } from '../../engine/types'

/** Soccer's opaque per-match state, as seen by the engine. */
export interface SoccerMatchState {
  homeScore: number
  awayScore: number
  elapsedTicks: number
}

/** Tunable soccer-specific rates. Widening this later with stat-driven
 *  fields (e.g. per-player contributions) never changes the tick() signature. */
export interface SoccerConfig {
  ticksPerMatch: number
  homeChancePerTick: number
  awayChancePerTick: number
  homeConversionRate: number
  awayConversionRate: number
}

export const DEFAULT_SOCCER_CONFIG: SoccerConfig = {
  ticksPerMatch: 90,
  homeChancePerTick: 0.08,
  awayChancePerTick: 0.07,
  homeConversionRate: 0.32,
  awayConversionRate: 0.26,
}

/** Tick interval, in milliseconds, tuned so a full match resolves in well
 *  under a couple of minutes of real time. */
export const SOCCER_TICK_INTERVAL_MS = 600

function createInitialState(): SoccerMatchState {
  return { homeScore: 0, awayScore: 0, elapsedTicks: 0 }
}

function tick(
  state: SoccerMatchState,
  tickIndex: number,
  config: SoccerConfig,
): TickResult<SoccerMatchState> {
  let { homeScore, awayScore } = state
  let scoringEvent = false

  // Home side: does a scoring chance occur this tick, and is it converted?
  if (Math.random() < config.homeChancePerTick) {
    if (Math.random() < config.homeConversionRate) {
      homeScore += 1
      scoringEvent = true
    }
  }

  // Away side: independent roll, same two-stage chance-then-conversion shape.
  if (Math.random() < config.awayChancePerTick) {
    if (Math.random() < config.awayConversionRate) {
      awayScore += 1
      scoringEvent = true
    }
  }

  return {
    state: {
      homeScore,
      awayScore,
      elapsedTicks: tickIndex + 1,
    },
    scoringEvent,
  }
}

/** Exported so UI can derive a live "if the match ended now" projected
 *  outcome from mid-match state, reusing the exact same logic the engine
 *  uses at actual match completion — never duplicated in a component. */
export function getOutcome(state: SoccerMatchState): MatchOutcome {
  if (state.homeScore > state.awayScore) return 'win'
  if (state.homeScore === state.awayScore) return 'draw'
  return 'loss'
}

export function createSoccerModule(
  config: SoccerConfig = DEFAULT_SOCCER_CONFIG,
): SportModule<SoccerMatchState> {
  return {
    id: 'soccer',
    ticksPerMatch: config.ticksPerMatch,
    createInitialState,
    tick: (state, tickIndex) => tick(state, tickIndex, config),
    getOutcome,
  }
}

/**
 * Soccer's venture tiers (Adventure-Capitalist-style parallel revenue
 * generators). Each tier runs its own independent match through the exact
 * same createSoccerModule()/tick()/getOutcome() above — the match
 * simulation itself never diverges per tier. The only per-tier difference
 * is a revenue multiplier applied on top of economy.ts's base win/draw/loss
 * payout, so src/engine/economy.ts stays untouched and tier-agnostic.
 *
 * Tier names/numbers are sport-specific vocabulary, so they live here (the
 * only file allowed to name soccer competition tiers) rather than in the
 * store. A second sport (step 3) defines its own tier list the same way.
 */
export interface SoccerVentureTierConfig {
  id: string
  name: string
  /** Multiplier applied to economy.ts's base outcome revenue at upgrade level 1. */
  baseRevenueMultiplier: number
  /** Cumulative revenue the immediately preceding tier must earn before this tier unlocks. Ignored for the first tier. */
  unlockThreshold: number
  /** One-time Revenue cost to unlock auto-play for this tier. */
  managerHireCost: number
  /** Cost of this tier's first "Improve Training" upgrade (level 1 -> 2). */
  upgradeBaseCost: number
  /** Per-level cost growth rate — a mild exponential curve. */
  upgradeCostGrowth: number
}

export const SOCCER_VENTURE_TIERS: SoccerVentureTierConfig[] = [
  {
    id: 'local-game',
    name: 'Local Game',
    baseRevenueMultiplier: 1,
    unlockThreshold: 0,
    managerHireCost: 150,
    upgradeBaseCost: 100,
    upgradeCostGrowth: 1.6,
  },
  {
    id: 'local-tournament',
    name: 'Local Tournament',
    baseRevenueMultiplier: 4,
    unlockThreshold: 450,
    managerHireCost: 500,
    upgradeBaseCost: 300,
    upgradeCostGrowth: 1.6,
  },
  {
    id: 'regional-championship',
    name: 'Regional Championship',
    baseRevenueMultiplier: 12,
    unlockThreshold: 2250,
    managerHireCost: 2500,
    upgradeBaseCost: 1200,
    upgradeCostGrowth: 1.65,
  },
  {
    id: 'national-league',
    name: 'National League',
    baseRevenueMultiplier: 35,
    unlockThreshold: 11250,
    managerHireCost: 12000,
    upgradeBaseCost: 5000,
    upgradeCostGrowth: 1.7,
  },
]

/** Revenue cost to raise a tier currently at `currentLevel` to the next level. */
export function tierUpgradeCost(config: SoccerVentureTierConfig, currentLevel: number): number {
  return Math.round(config.upgradeBaseCost * config.upgradeCostGrowth ** (currentLevel - 1))
}

/** Base direct Revenue granted per tick (manual click or automated) at
 *  multiplier=1, level=1, before tier/level scaling. Tuned so a brand-new
 *  Local Game player reaches their first affordable purchase (Improve
 *  Training, cost 100) in ~25s at an assumed 1 click/sec manual pace. */
export const BASE_PER_TICK_REVENUE = 4

/** Direct Revenue granted for a single tick at this tier/level — the
 *  "clicking is the primary generator" amount, added every tick (manual or
 *  auto) on top of the existing match-completion bonus. Scales by the same
 *  baseRevenueMultiplier * level factor the completion bonus already uses,
 *  so relative tier/level progression stays consistent between the two. */
export function tierPerTickRevenue(config: SoccerVentureTierConfig, level: number): number {
  return Math.round(BASE_PER_TICK_REVENUE * config.baseRevenueMultiplier * level)
}
