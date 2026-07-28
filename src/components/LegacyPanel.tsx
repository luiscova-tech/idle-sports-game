import { useGameStore } from '../store/useGameStore'
import { calculateLegacyPoints, PERMANENT_UPGRADES, unlockCostMultiplier } from '../engine/prestige'
import {
  SOCCER_VENTURE_TIERS,
  revealedTierCount,
  allVisibleTiersUnlocked,
  MAX_POST_PRESTIGE_REVEALS,
} from '../sports/soccer/soccerModule'
import './LegacyPanel.css'

// Distinct visual system from VentureCard on purpose (see index.css's
// --color-legacy* tokens) — Legacy Points are a different currency type
// entirely, earned by prestiging rather than by playing tiers directly.
function LegacyPanel() {
  const tiers = useGameStore((s) => s.tiers)
  const legacy = useGameStore((s) => s.legacy)
  const resetForLegacy = useGameStore((s) => s.resetForLegacy)
  const purchaseLegacyUpgrade = useGameStore((s) => s.purchaseLegacyUpgrade)

  // Reads the exact same check the store's resetForLegacy() enforces (see
  // allVisibleTiersUnlocked in soccerModule.ts) — this panel's locked-vs-
  // available UI can never drift from what the store would actually accept,
  // since both read one shared function rather than two independently-
  // written conditions. Generalizes past the first prestige automatically:
  // as later prestiges reveal more tiers, this requires the larger visible
  // set unlocked too, with no per-stage special-casing here.
  const canResetForLegacy = allVisibleTiersUnlocked(tiers, legacy.prestigeCount)
  const totalEarnings = tiers.reduce((sum, t) => sum + t.cumulativeRevenue, 0)
  const previewGain = calculateLegacyPoints(totalEarnings)

  // One additional hidden tier reveals per completed prestige (see
  // revealedTierCount in soccerModule.ts) rather than all of tiers 7-11
  // unlocking together on the first one — this copy reflects that directly,
  // naming the specific next tier still to come rather than implying a
  // single all-at-once unlock.
  const revealedCount = revealedTierCount(legacy.prestigeCount)
  const nextTierToReveal = SOCCER_VENTURE_TIERS[revealedCount]
  // The last tier in the CURRENTLY-visible set — names the actual full
  // requirement in the locked-explainer copy below, since that requirement
  // now spans every visible tier (not just one fixed tier), and which tier
  // is "last" grows as prestiges reveal more of the ladder.
  const lastVisibleTier = SOCCER_VENTURE_TIERS[revealedCount - 1]
  // Counts what's left AFTER the reveal the NEXT prestige itself causes —
  // legacy.prestigeCount hasn't incremented yet (that happens inside
  // resetForLegacy), so this must look one prestige ahead of the current
  // count, not use it as-is (an earlier version counted the about-to-be-
  // revealed tier itself as still "remaining," off by one).
  const postPrestigeRevealsRemainingAfterNext =
    MAX_POST_PRESTIGE_REVEALS - Math.min(legacy.prestigeCount + 1, MAX_POST_PRESTIGE_REVEALS)

  const handleResetForLegacy = () => {
    const revealNote = nextTierToReveal
      ? ` It will also permanently reveal ${nextTierToReveal.name}.`
      : ''
    const trainingNote =
      ' Every currently-unlocked tier\'s "Improve Training" level resets too, so your odds against ' +
      'each tier\'s opponents drop back down until you retrain.'
    const confirmed = window.confirm(
      `Reset for Legacy?\n\nThis wipes all Revenue and every tier's level/unlocks/matches back ` +
        `to a fresh ${SOCCER_VENTURE_TIERS[0].name} start. You will gain ${previewGain} Legacy Points, ` +
        `which are kept permanently along with any Legacy upgrades you've bought.${revealNote}${trainingNote} This cannot be undone.`,
    )
    if (confirmed) resetForLegacy()
  }

  const { permanentUpgrades: levels } = legacy

  return (
    <section className="legacy-panel" aria-label="Legacy">
      <div className="legacy-panel__header">
        <h2 className="legacy-panel__title">Legacy</h2>
        <div className="legacy-panel__points">
          <span className="legacy-panel__points-value">{legacy.legacyPoints}</span>
          <span className="legacy-panel__points-label">Legacy Points</span>
        </div>
      </div>

      {!canResetForLegacy ? (
        <p className="legacy-panel__locked-note">
          Unlock every tier through {lastVisibleTier.name} to unlock Reset for Legacy — a permanent
          prestige system that trades this run's progress for Legacy Points and lasting upgrades. Your
          first prestige also reveals a hidden next tier beyond the ladder shown here — and each
          prestige after that reveals one more, one at a time.
        </p>
      ) : (
        <div className="legacy-panel__reset-block">
          <p className="legacy-panel__preview">
            Resetting for Legacy now would grant <strong>{previewGain} Legacy Points</strong> (based on{' '}
            {totalEarnings.toLocaleString()} total Revenue earned this run).
          </p>
          {nextTierToReveal ? (
            <p className="legacy-panel__reveal-note">
              Prestiging again will permanently reveal <strong>{nextTierToReveal.name}</strong>
              {postPrestigeRevealsRemainingAfterNext > 0
                ? ` (${postPrestigeRevealsRemainingAfterNext} more tier${
                    postPrestigeRevealsRemainingAfterNext > 1 ? 's' : ''
                  } to reveal after that)`
                : ''}
              .
            </p>
          ) : (
            <p className="legacy-panel__reveal-note">
              Every tier is revealed. Prestiging further only earns more Legacy Points.
            </p>
          )}
          <button type="button" className="btn btn--legacy" onClick={handleResetForLegacy}>
            Reset for Legacy
          </button>
        </div>
      )}

      <div className="legacy-panel__upgrades">
        <h3 className="legacy-panel__upgrades-title">Permanent Upgrades</h3>

        <div className="legacy-upgrade">
          <div className="legacy-upgrade__info">
            <span className="legacy-upgrade__name">{PERMANENT_UPGRADES.revenueBoost.label}</span>
            <span className="legacy-upgrade__desc">{PERMANENT_UPGRADES.revenueBoost.description}</span>
            <span className="legacy-upgrade__level">Level {levels.revenueBoostLevel} (no cap)</span>
          </div>
          <button
            type="button"
            className="btn btn--legacy-purchase"
            onClick={() => purchaseLegacyUpgrade('revenueBoost')}
            disabled={
              legacy.legacyPoints <
              PERMANENT_UPGRADES.revenueBoost.costForLevel(levels.revenueBoostLevel + 1)
            }
          >
            Buy ({PERMANENT_UPGRADES.revenueBoost.costForLevel(levels.revenueBoostLevel + 1)} LP)
          </button>
        </div>

        <div className="legacy-upgrade">
          <div className="legacy-upgrade__info">
            <span className="legacy-upgrade__name">{PERMANENT_UPGRADES.headStartCapital.label}</span>
            <span className="legacy-upgrade__desc">{PERMANENT_UPGRADES.headStartCapital.description}</span>
          </div>
          {levels.headStartCapital ? (
            <span className="legacy-upgrade__maxed">OWNED</span>
          ) : (
            <button
              type="button"
              className="btn btn--legacy-purchase"
              onClick={() => purchaseLegacyUpgrade('headStartCapital')}
              disabled={legacy.legacyPoints < PERMANENT_UPGRADES.headStartCapital.cost}
            >
              Buy ({PERMANENT_UPGRADES.headStartCapital.cost} LP)
            </button>
          )}
        </div>

        <div className="legacy-upgrade">
          <div className="legacy-upgrade__info">
            <span className="legacy-upgrade__name">{PERMANENT_UPGRADES.fastTrack.label}</span>
            <span className="legacy-upgrade__desc">{PERMANENT_UPGRADES.fastTrack.description}</span>
          </div>
          {levels.fastTrack ? (
            <span className="legacy-upgrade__maxed">OWNED</span>
          ) : (
            <button
              type="button"
              className="btn btn--legacy-purchase"
              onClick={() => purchaseLegacyUpgrade('fastTrack')}
              disabled={legacy.legacyPoints < PERMANENT_UPGRADES.fastTrack.cost}
            >
              Buy ({PERMANENT_UPGRADES.fastTrack.cost} LP)
            </button>
          )}
        </div>

        <div className="legacy-upgrade">
          <div className="legacy-upgrade__info">
            <span className="legacy-upgrade__name">{PERMANENT_UPGRADES.veteranDiscount.label}</span>
            <span className="legacy-upgrade__desc">{PERMANENT_UPGRADES.veteranDiscount.description}</span>
            <span className="legacy-upgrade__level">
              Level {levels.veteranDiscountLevel} (no cap) —{' '}
              {Math.round((1 - unlockCostMultiplier(levels)) * 100)}% off currently
            </span>
          </div>
          <button
            type="button"
            className="btn btn--legacy-purchase"
            onClick={() => purchaseLegacyUpgrade('veteranDiscount')}
            disabled={
              legacy.legacyPoints <
              PERMANENT_UPGRADES.veteranDiscount.costForLevel(levels.veteranDiscountLevel + 1)
            }
          >
            Buy ({PERMANENT_UPGRADES.veteranDiscount.costForLevel(levels.veteranDiscountLevel + 1)} LP)
          </button>
        </div>
      </div>
    </section>
  )
}

export default LegacyPanel
