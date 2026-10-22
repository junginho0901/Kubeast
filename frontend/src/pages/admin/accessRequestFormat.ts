// Display helpers for access requests (admin page and the account section).
import type { TFunction } from 'i18next'

// "90 min" / "2 h" / "1 h 30 min", in the UI language when t is given.
export function formatDuration(minutes: number, t?: TFunction): string {
  const tr = (key: string, fallback: string, vals: Record<string, number>) =>
    t ? t(key, { defaultValue: fallback, ...vals }) : fallback.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(vals[k]))
  if (minutes < 60) return tr('accessRequests.durationMin', '{{m}} min', { m: minutes })
  if (minutes % 60 === 0) return tr('accessRequests.durationH', '{{h}} h', { h: minutes / 60 })
  return tr('accessRequests.durationHMin', '{{h}} h {{m}} min', { h: Math.floor(minutes / 60), m: minutes % 60 })
}

export { formatTime as formatWhen } from '@/utils/time'
