// ============================================================
// src/engine/types.ts
// Sport-agnostic contract. Must never import from src/sports/** and must
// never mention goal, possession, shot, or any other sport-specific noun.
// ============================================================

/** Outcome of a completed match, from the player's managed side's perspective. */
export type MatchOutcome = 'win' | 'draw' | 'loss'

/** What a sport module's per-tick simulation step hands back to the engine. */
export interface TickResult<TState> {
  /** The sport module's own opaque state after this tick. */
  state: TState
  /** Optional hint that something UI-notable happened this tick (e.g. a
   *  score change). Purely advisory — the engine never acts on it. */
  scoringEvent?: boolean
}

/** What the engine produces once a match's tick count is exhausted. */
export interface MatchResult<TState> {
  finalState: TState
  outcome: MatchOutcome
  revenue: number
}

/**
 * The contract every sport plugs into. TState is fully opaque to the engine:
 * it is never read or written by engine code, only passed to/from these
 * methods. Widening TState later (e.g. adding player-stat fields for a
 * future build-order step) never requires changing this interface, and a
 * second sport module implements the same interface with zero engine changes.
 */
export interface SportModule<TState> {
  /** Label for UI/debugging only, e.g. "soccer". */
  readonly id: string
  /** Total ticks in one match. Opaque to the engine — it has no idea if a
   *  "tick" means a match-minute, a possession, or anything else. */
  readonly ticksPerMatch: number

  /** Produce a fresh match state (called at match start and after each reset). */
  createInitialState(): TState

  /** Advance the match by exactly one tick. (state, tickIndex) is a plain
   *  pair so a later step can widen TState with stat-driven fields without
   *  touching this signature. */
  tick(state: TState, tickIndex: number): TickResult<TState>

  /** Decide the match outcome from final state. Sport-owned: the engine has
   *  no notion of what "winning" means for a given sport. */
  getOutcome(state: TState): MatchOutcome
}
