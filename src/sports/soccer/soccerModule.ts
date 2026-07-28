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
  /** Placeholder tier art — a single emoji, standing in for real
   *  AI-generated icon/sprite art (step 9). Chosen to track this ladder's
   *  grounded -> epic -> absurd tone arc from tier 1 to tier 11. */
  icon: string
  /** Multiplier applied to economy.ts's base outcome revenue at upgrade level 1. */
  baseRevenueMultiplier: number
  /** Revenue cost to unlock this tier, paid from the player's current
   *  spendable balance (same pool as Improve Training/Hire a Manager) —
   *  a deliberate player choice, not an automatic threshold. Ignored for
   *  the first tier, which starts unlocked. */
  unlockCost: number
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
    name: 'The Sunday League',
    icon: '⚽',
    baseRevenueMultiplier: 1,
    unlockCost: 0,
    managerHireCost: 150,
    upgradeBaseCost: 100,
    upgradeCostGrowth: 1.6,
  },
  {
    id: 'local-tournament',
    name: 'The Corner Kick Cup',
    icon: '🚩',
    baseRevenueMultiplier: 4,
    unlockCost: 450,
    managerHireCost: 500,
    upgradeBaseCost: 300,
    upgradeCostGrowth: 1.6,
  },
  {
    id: 'regional-championship',
    name: 'The Regional Rumble',
    icon: '🥉',
    baseRevenueMultiplier: 12,
    unlockCost: 2250,
    managerHireCost: 2500,
    upgradeBaseCost: 1200,
    upgradeCostGrowth: 1.65,
  },
  {
    id: 'national-league',
    name: 'The National Cup',
    icon: '🏅',
    baseRevenueMultiplier: 35,
    unlockCost: 11250,
    managerHireCost: 12000,
    upgradeBaseCost: 5000,
    upgradeCostGrowth: 1.7,
  },
  {
    id: 'continental-cup',
    name: 'The Continental Clash',
    icon: '🌍',
    baseRevenueMultiplier: 100,
    unlockCost: 56250,
    managerHireCost: 60000,
    upgradeBaseCost: 21000,
    upgradeCostGrowth: 1.75,
  },
  {
    id: 'world-championship',
    name: 'The World Crown',
    icon: '👑',
    baseRevenueMultiplier: 280,
    unlockCost: 281250,
    managerHireCost: 300000,
    upgradeBaseCost: 88200,
    upgradeCostGrowth: 1.8,
  },
  // Tiers 7-11, added once "Reset for Legacy" existed (see CLAUDE.md
  // "Prestige system" / "Post-prestige ladder"). Mechanical continuation of
  // the exact tier 1-6 curve — same 5x unlock/manager-cost growth, same
  // ~4.2x upgrade-base-cost growth, same +0.05-per-tier upgradeCostGrowth,
  // same gently-decreasing baseRevenueMultiplier ratio (2.8 -> 2.75 -> 2.70
  // -> 2.65 -> 2.60 -> 2.55) — no new balance philosophy introduced. These
  // stay invisible in the UI (see TIERS_REVEALED_BEFORE_PRESTIGE below)
  // until a player's first prestige, per that mechanic's design.
  {
    id: 'legends-circuit',
    name: "The Legends' Gauntlet",
    icon: '⚔️',
    baseRevenueMultiplier: 770,
    unlockCost: 1406250,
    managerHireCost: 1500000,
    upgradeBaseCost: 370440,
    upgradeCostGrowth: 1.85,
  },
  {
    id: 'galactic-league',
    name: 'The Interstellar Invitational',
    icon: '🚀',
    baseRevenueMultiplier: 2079,
    unlockCost: 7031250,
    managerHireCost: 7500000,
    upgradeBaseCost: 1555848,
    upgradeCostGrowth: 1.9,
  },
  {
    id: 'mythic-ascension',
    name: 'The Mythic Ascension',
    icon: '🐉',
    baseRevenueMultiplier: 5509,
    unlockCost: 35156250,
    managerHireCost: 37500000,
    upgradeBaseCost: 6534562,
    upgradeCostGrowth: 1.95,
  },
  {
    id: 'eternal-championship',
    name: 'The Eternal Crown',
    icon: '♾️',
    baseRevenueMultiplier: 14323,
    unlockCost: 175781250,
    managerHireCost: 187500000,
    upgradeBaseCost: 27445160,
    upgradeCostGrowth: 2.0,
  },
  {
    id: 'multiverse-cup',
    name: 'The Multiverse Cup',
    icon: '🌌',
    baseRevenueMultiplier: 36524,
    unlockCost: 878906250,
    managerHireCost: 937500000,
    upgradeBaseCost: 115269672,
    upgradeCostGrowth: 2.05,
  },
]

/** The tier whose unlock gates the FIRST "Reset for Legacy" — i.e. the
 *  original ladder's final tier. Looked up by id, deliberately NOT by
 *  `tiers[tiers.length - 1]`: once tiers 7-11 exist in this array, "the
 *  last tier" is The Multiverse Cup, which a player can only reach AFTER
 *  already prestiging once — checking by array-position would make a first
 *  prestige permanently impossible. This id-based constant is the fix, and
 *  stays correct no matter how many more tiers get appended later. */
export const FIRST_PRESTIGE_TRIGGER_TIER_ID = 'world-championship'

/** How many tiers (from the front of SOCCER_VENTURE_TIERS) are visible
 *  before a player's first prestige. Tiers beyond this index don't
 *  exist/render/get referenced in the UI at all until `legacy.hasPrestiged`
 *  is true — see Home.tsx and `isTierRevealed` below. Derived from
 *  FIRST_PRESTIGE_TRIGGER_TIER_ID rather than a second hand-maintained
 *  number, so the reveal boundary and the prestige-trigger tier can never
 *  silently drift apart. */
export const TIERS_REVEALED_BEFORE_PRESTIGE =
  SOCCER_VENTURE_TIERS.findIndex((c) => c.id === FIRST_PRESTIGE_TRIGGER_TIER_ID) + 1

/** Whether the tier at `tierIndex` is allowed to exist/be interacted with
 *  right now. This is the single authoritative check for the reveal
 *  boundary — every store action that touches a tier (tick/upgrade/hire
 *  manager/unlock) calls this, not just Home.tsx's render slice, so tiers
 *  7-11 can't be made to earn real Revenue (e.g. via a hand-edited
 *  localStorage save flipping `unlocked` directly) before a player has
 *  actually prestiged once. */
export function isTierRevealed(tierIndex: number, hasPrestiged: boolean): boolean {
  return tierIndex < TIERS_REVEALED_BEFORE_PRESTIGE || hasPrestiged
}

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
