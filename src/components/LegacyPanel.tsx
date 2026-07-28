import { useGameStore } from '../store/useGameStore'
import { calculateLegacyPoints, PERMANENT_UPGRADES } from '../engine/prestige'
import './LegacyPanel.css'

// Distinct visual system from VentureCard on purpose (see index.css's
// --color-legacy* tokens) — Legacy Points are a different currency type
// entirely, earned by prestiging rather than by playing tiers directly.
function LegacyPanel() {
  const tiers = useGameStore((s) => s.tiers)
  const legacy = useGameStore((s) => s.legacy)
  const resetForLegacy = useGameStore((s) => s.resetForLegacy)
  const purchaseLegacyUpgrade = useGameStore((s) => s.purchaseLegacyUpgrade)

  const finalTier = tiers[tiers.length - 1]
  const finalTierUnlocked = finalTier?.unlocked ?? false
  const totalEarnings = tiers.reduce((sum, t) => sum + t.cumulativeRevenue, 0)
  const previewGain = calculateLegacyPoints(totalEarnings)

  const handleResetForLegacy = () => {
    const confirmed = window.confirm(
      `Reset for Legacy?\n\nThis wipes all Revenue and every tier's level/unlocks/matches back ` +
        `to a fresh Local Game start. You will gain ${previewGain} Legacy Points, which are kept ` +
        `permanently along with any Legacy upgrades you've bought. This cannot be undone.`,
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

      {!finalTierUnlocked ? (
        <p className="legacy-panel__locked-note">
          Reach and unlock {finalTier?.id === 'world-championship' ? 'World Championship' : 'the final tier'} to
          unlock Reset for Legacy — a permanent prestige system that trades this run's progress for Legacy
          Points and lasting upgrades.
        </p>
      ) : (
        <div className="legacy-panel__reset-block">
          <p className="legacy-panel__preview">
            Resetting for Legacy now would grant <strong>{previewGain} Legacy Points</strong> (based on{' '}
            {totalEarnings.toLocaleString()} total Revenue earned this run).
          </p>
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
            <span className="legacy-upgrade__level">
              Level {levels.revenueBoostLevel}/{PERMANENT_UPGRADES.revenueBoost.maxLevel}
            </span>
          </div>
          {levels.revenueBoostLevel >= PERMANENT_UPGRADES.revenueBoost.maxLevel ? (
            <span className="legacy-upgrade__maxed">MAXED</span>
          ) : (
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
          )}
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
              Level {levels.veteranDiscountLevel}/{PERMANENT_UPGRADES.veteranDiscount.maxLevel}
            </span>
          </div>
          {levels.veteranDiscountLevel >= PERMANENT_UPGRADES.veteranDiscount.maxLevel ? (
            <span className="legacy-upgrade__maxed">MAXED</span>
          ) : (
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
          )}
        </div>
      </div>
    </section>
  )
}

export default LegacyPanel
