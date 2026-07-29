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
 * progression means. All fields are optional and generic on purpose:
 *  - `level`: an arbitrary progression number the caller knows about (e.g. a
 *    venture tier's "Improve Training" level). A sport module with no such
 *    concept ignores it entirely.
 *  - `opponentLevelRange`: the [min, max] band a per-match "opponent
 *    strength" level may be drawn from, for a sport module that models
 *    match difficulty as a level-gap-driven win probability. Omitted (or
 *    undefined) means no such model applies. The engine has no idea what
 *    "level" represents for a given sport, nor what drawing a value from
 *    this range means — it only ever threads this object through unread,
 *    and a sport module interprets both numbers itself.
 *  - `matchLength`: an arbitrary per-match length parameter the caller
 *    knows about (e.g. how many innings a given venture tier's games go),
 *    for a sport module whose match STRUCTURE (not just its win
 *    probability) varies by tier. A sport module with a fixed match length
 *    (soccer's 90 ticks, the same at every tier) ignores it entirely, the
 *    same way a sport module with no gap-driven win model ignores
 *    opponentLevelRange. The engine has no idea what "length" means for a
 *    given sport (an inning count, a lap count, anything) — only a sport
 *    module's own tick()/isMatchComplete() implementation interprets it.
 * Neither tickEngine.ts nor the store give any of this fields sport-specific
 * meaning — only a sport module's own implementation may.
 *
 * (This superseded an earlier `minWinLevel` field — a hard "below this
 * level, a win is impossible" cliff — replaced by the continuous,
 * probability-based model `opponentLevelRange` supports. See soccerModule.ts
 * and CLAUDE.md for the replacement mechanism.)
 */
export interface MatchContext {
  level?: number
  opponentLevelRange?: { min: number; max: number }
  matchLength?: number
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
  /** Total ticks in one match, for a sport whose match length is fixed
   *  (e.g. soccer's 90 ticks). For a sport whose match length is genuinely
   *  VARIABLE (see isMatchComplete below), this is instead a rough ESTIMATE
   *  used only to size a progress-bar-style UI — it is not authoritative
   *  for deciding when the match actually ends in that case. Opaque to the
   *  engine either way — it has no idea if a "tick" means a match-minute,
   *  an at-bat, or anything else. */
  readonly ticksPerMatch: number

  /** Produce a fresh match state (called at match start and after each reset). */
  createInitialState(): TState

  /** Advance the match by exactly one tick. (state, tickIndex) is a plain
   *  pair so a later step can widen TState with stat-driven fields without
   *  touching this signature. `context` is optional — a sport module that
   *  has no use for outside progression during ticking simply omits the
   *  parameter from its own implementation. A sport module that DOES use it
   *  (e.g. to resolve a probability-based outcome once, early in the match)
   *  is responsible for storing whatever it decided into its own opaque
   *  TState, so later calls to getOutcome()/getPerformanceFactor() — which
   *  must stay pure, idempotent functions of state alone, safely callable
   *  many times (e.g. for a live "current standing" UI preview) without
   *  re-rolling anything — can read it back out deterministically. */
  tick(state: TState, tickIndex: number, context?: MatchContext): TickResult<TState>

  /** Decide the match outcome from final state. Sport-owned: the engine has
   *  no notion of what "winning" means for a given sport. `context` is
   *  optional — see MatchContext above; a sport module with no such concept
   *  ignores it and returns the same result regardless. Most sport modules
   *  that DO use context resolve everything context-dependent inside
   *  tick() (see above) and have this method simply read that already-
   *  decided result back out of state — context is accepted here mainly
   *  for interface symmetry/future flexibility, not because every
   *  implementation needs to re-consult it. */
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
   *  Takes the same optional `context` as getOutcome for interface
   *  symmetry. Whatever a sport module uses to decide getOutcome()'s result
   *  MUST be exactly what this derives its factor from — computing the two
   *  from independently-driftable sources is how a margin bonus can leak
   *  into an outcome the caller never intended to receive one for (this bit
   *  a prior version of this game's soccer module once; see soccerModule.ts
   *  and CLAUDE.md for the fix). The safest pattern, and the one
   *  soccerModule.ts uses, is a single shared private helper both methods
   *  read from, so the two can't drift apart even as the sport module's own
   *  resolution logic changes. */
  getPerformanceFactor(state: TState, context?: MatchContext): number

  /**
   * Optional: for a sport whose match length can't be known in advance from
   * a fixed tick count (e.g. baseball — a half-inning needs exactly 3 outs,
   * which random hit/out/walk rolls take a variable number of at-bats to
   * reach), this is the AUTHORITATIVE completion check, used INSTEAD of
   * comparing the raw tick count against ticksPerMatch. See isMatchComplete
   * in tickEngine.ts for exactly how the two are combined.
   *
   * A sport module that omits this (soccer, whose matches are always
   * exactly ticksPerMatch ticks) is completely unaffected — the engine
   * falls back to the original tick-count comparison, byte-for-byte the
   * same behavior as before this capability existed. This is a genuine,
   * deliberately small and backward-compatible engine-contract extension,
   * not a rework of the existing fixed-length path (see CLAUDE.md's
   * "Baseball" amendment for why a fixed ticksPerMatch alone can't
   * correctly represent a variable-length match).
   */
  isMatchComplete?(state: TState): boolean
}
