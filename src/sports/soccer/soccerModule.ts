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

function getOutcome(state: SoccerMatchState): MatchOutcome {
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
