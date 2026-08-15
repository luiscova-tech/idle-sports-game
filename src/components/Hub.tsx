import { useGameStore, visibleTierUnlockProgress } from '../store/useGameStore'
import { nearestAchievementProgress } from '../engine/achievements'
import { revealedTierCount, allVisibleTiersUnlocked } from '../sports/soccer/soccerModule'
import { BASEBALL_VENTURE_TIERS } from '../sports/baseball/baseballModule'
import soccerBuildingImage from '../assets/buildings/soccer-building.jpg'
import baseballBuildingImage from '../assets/buildings/baseball-building.jpg'
import franchiseHqBuildingImage from '../assets/buildings/franchise-hq-building.jpg'
import './Hub.css'

/** Which building the player tapped — mirrors Home.tsx's ViewId minus
 *  'hub' itself, since the hub never links to itself. */
export type BuildingId = 'soccer' | 'baseball' | 'franchise'

interface HubProps {
  onEnter: (building: BuildingId) => void
}

/**
 * The hub: the landing view on every load (see Home.tsx — deliberately NOT
 * "remember last screen"), showing three buildings the player taps to enter
 * Soccer, Baseball, or Franchise HQ.
 *
 * ── THE SHARED-DERIVATION RULE (the correctness-sensitive part) ──
 * Every at-a-glance number below is derived from the SAME store state and
 * the SAME shared helper functions the real screens use — never a second,
 * separately-written computation. Concretely:
 *   - achievement teasers  -> nearestAchievementProgress (engine/achievements.ts),
 *     the exact function AchievementsPanel renders each line from. It was
 *     extracted out of that component specifically so this teaser and that
 *     panel cannot disagree.
 *   - tier counts          -> visibleTierUnlockProgress (useGameStore.ts) over
 *     the live `tiers`/`baseballTiers` arrays, with soccer's denominator from
 *     revealedTierCount(prestigeCount) — the identical function SoccerTab
 *     slices its rendered card list with.
 *   - prestige readiness   -> allVisibleTiersUnlocked (soccerModule.ts), the
 *     same gate LegacyPanel's UI and the store's resetForLegacy() both check.
 *   - Legacy Points        -> legacy.legacyPoints, read straight from the store.
 * If a future stat is added here, it must follow the same rule: reuse (or
 * extract) the screen's own derivation rather than recomputing it.
 *
 * Each building card's hero image is real illustrated art (see CLAUDE.md's
 * "Hub building art" amendment) — scoped to these three hub cards only. The
 * emoji placeholders used WITHIN each sport's own screen (venture tier
 * cards, achievement badges) are untouched and out of scope here; step 9's
 * broader placeholder-art pass is still pending for those.
 */
function Hub({ onEnter }: HubProps) {
  const tiers = useGameStore((s) => s.tiers)
  const baseballTiers = useGameStore((s) => s.baseballTiers)
  const prestigeCount = useGameStore((s) => s.legacy.prestigeCount)
  const legacyPoints = useGameStore((s) => s.legacy.legacyPoints)

  // Same three stats AchievementsPanel maps into its own generic record —
  // fed to the same nearestAchievementProgress helper it uses.
  const totalWins = useGameStore((s) => s.lifetimeStats.totalWins)
  const soccerWins = useGameStore((s) => s.lifetimeStats.soccerWins)
  const baseballWins = useGameStore((s) => s.lifetimeStats.baseballWins)
  const earnedIds = useGameStore((s) => s.achievements.earnedIds)
  const stats: Record<string, number> = { totalWins, soccerWins, baseballWins }

  const soccerTierProgress = visibleTierUnlockProgress(tiers, revealedTierCount(prestigeCount))
  const baseballTierProgress = visibleTierUnlockProgress(baseballTiers, BASEBALL_VENTURE_TIERS.length)

  const soccerAchievement = nearestAchievementProgress(stats, earnedIds, 'soccerWins')
  const baseballAchievement = nearestAchievementProgress(stats, earnedIds, 'baseballWins')

  // The prestige gate itself — not a re-derivation of it. `allVisibleTiersUnlocked`
  // is the same function LegacyPanel gates its reset block on and the store
  // enforces inside resetForLegacy(), so "Ready to prestige" here can never
  // claim something the Franchise screen would then refuse.
  const prestigeReady = allVisibleTiersUnlocked(tiers, prestigeCount)
  // Progress toward that gate reuses the soccer tier counts above (the gate
  // is exactly "every visible soccer tier unlocked"), so the two readouts
  // are guaranteed consistent by construction — no separate gate-progress
  // computation exists here to drift from the gate itself.

  const buildings = [
    {
      id: 'soccer' as const,
      image: soccerBuildingImage,
      imageAlt: 'Soccer stadium building',
      name: 'Soccer',
      tagline: 'Your football club',
      stats: [
        {
          label: 'Tiers unlocked',
          value: `${soccerTierProgress.unlocked}/${soccerTierProgress.visible}`,
        },
        {
          label: soccerAchievement.nextUnearned
            ? `Next: ${soccerAchievement.nextUnearned.name}`
            : 'Achievements',
          value: soccerAchievement.nextUnearned
            ? `${soccerAchievement.currentValue.toLocaleString()} / ${soccerAchievement.nextUnearned.threshold.toLocaleString()}`
            : 'All earned',
          percent: soccerAchievement.progressPercent,
        },
      ],
    },
    {
      id: 'baseball' as const,
      image: baseballBuildingImage,
      imageAlt: 'Baseball park building',
      name: 'Baseball',
      tagline: 'Your ball club',
      stats: [
        {
          label: 'Tiers unlocked',
          value: `${baseballTierProgress.unlocked}/${baseballTierProgress.visible}`,
        },
        {
          label: baseballAchievement.nextUnearned
            ? `Next: ${baseballAchievement.nextUnearned.name}`
            : 'Achievements',
          value: baseballAchievement.nextUnearned
            ? `${baseballAchievement.currentValue.toLocaleString()} / ${baseballAchievement.nextUnearned.threshold.toLocaleString()}`
            : 'All earned',
          percent: baseballAchievement.progressPercent,
        },
      ],
    },
    {
      id: 'franchise' as const,
      image: franchiseHqBuildingImage,
      imageAlt: 'Franchise headquarters building',
      name: 'Franchise HQ',
      tagline: 'Legacy & prestige',
      stats: [
        { label: 'Legacy Points', value: legacyPoints.toLocaleString() },
        prestigeReady
          ? { label: 'Prestige', value: 'Ready to reset' }
          : {
              // Kept short so it can't wrap into a multi-line block and
              // squeeze the value beside it — the Franchise screen itself
              // still names the specific tier still to unlock
              // (`lastVisibleTier`, below) in its locked explainer.
              label: 'Prestige — not yet ready',
              value: `${soccerTierProgress.unlocked}/${soccerTierProgress.visible} soccer tiers`,
              percent: soccerTierProgress.visible
                ? Math.round((soccerTierProgress.unlocked / soccerTierProgress.visible) * 100)
                : 0,
            },
      ],
    },
  ]

  return (
    <section className="hub" aria-label="Franchise hub">
      <p className="hub__intro">Choose where to work today.</p>
      <div className="hub__buildings">
        {buildings.map((building) => (
          <button
            key={building.id}
            type="button"
            className={`hub-building hub-building--${building.id}`}
            onClick={() => onEnter(building.id)}
          >
            <span className="hub-building__hero">
              <img className="hub-building__image" src={building.image} alt={building.imageAlt} />
            </span>

            <span className="hub-building__body">
              <span className="hub-building__name">{building.name}</span>
              <span className="hub-building__tagline">{building.tagline}</span>

              <span className="hub-building__stats">
                {building.stats.map((stat) => (
                  <span className="hub-stat" key={stat.label}>
                    <span className="hub-stat__row">
                      <span className="hub-stat__label">{stat.label}</span>
                      <span className="hub-stat__value">{stat.value}</span>
                    </span>
                    {stat.percent !== undefined && (
                      <span className="hub-stat__track">
                        <span className="hub-stat__fill" style={{ width: `${stat.percent}%` }} />
                      </span>
                    )}
                  </span>
                ))}
              </span>

              <span className="hub-building__enter">Enter →</span>
            </span>
          </button>
        ))}
      </div>
    </section>
  )
}

export default Hub
