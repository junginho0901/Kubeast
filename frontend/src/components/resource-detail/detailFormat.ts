// Time formatting helpers shared by the resource detail views — the same
// formats as the lists (utils/time): an age as kubectl prints it, an absolute
// time as YYYY-MM-DD HH:mm:ss in the viewer's time zone.
import { formatAge, formatTime } from '@/utils/time'

export const fmtRel = formatAge
export const fmtTs = formatTime
export const fmtPodAge = formatAge

// A drawer's events newest first by their last time; an answer without a list (not read) stays undefined, so the
// Events section says they could not be read instead of "None".
export function eventsNewestFirst(events: unknown): any[] | undefined {
  if (!Array.isArray(events)) return undefined
  const at = (e: any) => new Date(e?.last_timestamp || e?.first_timestamp || 0).getTime()
  return [...events].sort((a, b) => at(b) - at(a))
}
