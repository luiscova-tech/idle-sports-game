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
 * Optional per-match context an external caller (the store) MAY supply so a
 * sport module can let outside progression affect match resolution, without
 * the engine or a second sport module ever being forced to know what that
 * progression means. Both fields are optional and generic on purpose:
 *  - `level`: an arbitrary progression number the caller knows about (e.g. a
 *    venture tier's "Improve Training" level). A sport module with no such
 *    concept ignores it entirely.
 *  - `minWinLevel`: the minimum `level` required before a 'win' outcome is
 *    achievable at all — below it, only 'draw'/'loss' can occur. Omitted (or
 *    undefined) means no gating applies. The engine has no idea what
 *    "level" represents for a given sport; it only ever threads this object
 *    through unread, and a sport module compares the two numbers itself.
 * Neither tickEngine.ts nor the store give this any sport-specific meaning —
 * only a sport module's own tick()/getOutcome() implementation may.
 */
export interface MatchContext {
  level?: number
  minWinLevel?: number
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
   *  touching this signature. `context` is optional — a sport module that
   *  has no use for outside progression during ticking simply omits the
   *  parameter from its own implementation. */
  tick(state: TState, tickIndex: number, context?: MatchContext): TickResult<TState>

  /** Decide the match outcome from final state. Sport-owned: the engine has
   *  no notion of what "winning" means for a given sport. `context` is
   *  optional — see MatchContext above; a sport module with no win-gating
   *  concept ignores it and returns the same result regardless. */
  getOutcome(state: TState, context?: MatchContext): MatchOutcome

  /** How decisive/lopsided this final state is, from the managed side's
   *  perspective, normalized to a generic 0-1 scale: 0 = the most lopsided
   *  possible loss, 0.5 = neutral (a draw always sits here), 1 = the most
   *  decisive possible win. Required (unlike the fields inside MatchContext
   *  above) because every sport has *some* notion of "how well did I do,"
   *  and economy.ts's margin-based revenue bonus depends on it — but
   *  economy.ts only ever consumes this single generic number, never the
   *  sport-specific stats (goals, possession, ...) behind it.
   *
   *  Takes the SAME optional `context` as getOutcome, for the same reason:
   *  if a sport module's getOutcome() downgrades an outcome based on
   *  context (e.g. a 'win' capped to 'draw' below some minimum level), its
   *  getPerformanceFactor() must be told the same context so it can report
   *  a consistent factor for that downgraded outcome (e.g. the neutral 0.5
   *  a real draw would report) — otherwise a relabeled-but-not-renormalized
   *  factor lets a margin bonus leak into an outcome economy.ts's caller
   *  never intended to receive one. A sport with no such downgrading
   *  concept simply ignores `context` here exactly as it does in
   *  getOutcome(). */
  getPerformanceFactor(state: TState, context?: MatchContext): number
}
