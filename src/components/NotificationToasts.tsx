import { useEffect } from 'react'
import { useGameStore } from '../store/useGameStore'
import './NotificationToasts.css'

/** How long a toast stays on screen once it's actually rendered. Timed from
 *  mount, not from when the underlying event happened (e.g. a milestone
 *  crossed by an auto-playing manager while the player was on the Settings
 *  page) — so a toast a player wasn't around to see doesn't silently expire
 *  unseen; it gets its full on-screen time starting from whenever they next
 *  see it. */
const DISMISS_AFTER_MS = 4000

function Toast({ id, message }: { id: number; message: string }) {
  const dismissNotification = useGameStore((s) => s.dismissNotification)

  useEffect(() => {
    const timer = setTimeout(() => dismissNotification(id), DISMISS_AFTER_MS)
    return () => clearTimeout(timer)
  }, [id, dismissNotification])

  return <div className="notification-toast">{message}</div>
}

/**
 * Rendered once in App.tsx (not per-route) so a milestone crossed while
 * auto-playing on the Settings page still surfaces the instant the player's
 * back on the main screen — same "the idle loop doesn't care which page
 * you're on" principle useMatchTicker already follows. Each toast owns its
 * own dismiss timer (see Toast above), so multiple simultaneous milestone
 * crossings (e.g. a hand-edited save jumping several levels at once) each
 * get their own independent countdown rather than one shared timer that
 * would cut later toasts short.
 */
function NotificationToasts() {
  const notifications = useGameStore((s) => s.notifications)

  if (notifications.length === 0) return null

  return (
    <div className="notification-toasts" aria-live="polite">
      {notifications.map((n) => (
        <Toast key={n.id} id={n.id} message={n.message} />
      ))}
    </div>
  )
}

export default NotificationToasts
