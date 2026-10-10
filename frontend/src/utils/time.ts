// Time on screen, one way everywhere: an absolute time as `YYYY-MM-DD HH:mm:ss`
// in the viewer's time zone (the UTC value goes in the tooltip, utcTitle), and an
// age the way kubectl prints AGE (apimachinery HumanDuration).

type TimeInput = string | number | Date | null | undefined

// A missing or unparsable value, and the Go zero time / Unix epoch that some
// fields carry when there is no time, read as "no time".
function toDate(value: TimeInput): Date | null {
  if (value === null || value === undefined || value === '') return null
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime()) || d.getFullYear() < 1980) return null
  return d
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Seconds since the time, 0 when there is none (a sort key). */
export function ageSeconds(value: TimeInput): number {
  const d = toDate(value)
  return d ? Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000)) : 0
}

/** k8s.io/apimachinery/pkg/util/duration.HumanDuration */
export function humanDuration(seconds: number): string {
  const s = Math.trunc(seconds)
  if (s < -1) return '<invalid>'
  if (s < 0) return '0s'
  if (s < 60 * 2) return `${s}s`
  const minutes = Math.floor(s / 60)
  if (minutes < 10) return s % 60 === 0 ? `${minutes}m` : `${minutes}m${s % 60}s`
  if (minutes < 60 * 3) return `${minutes}m`
  const hours = Math.floor(s / 3600)
  if (hours < 8) return minutes % 60 === 0 ? `${hours}h` : `${hours}h${minutes % 60}m`
  if (hours < 48) return `${hours}h`
  if (hours < 24 * 8) return hours % 24 === 0 ? `${hours / 24}d` : `${Math.floor(hours / 24)}d${hours % 24}h`
  const days = Math.floor(hours / 24)
  if (hours < 24 * 365 * 2) return `${days}d`
  if (hours < 24 * 365 * 8) return days % 365 === 0 ? `${days / 365}y` : `${Math.floor(days / 365)}y${days % 365}d`
  return `${Math.floor(days / 365)}y`
}

/** Age as kubectl prints it, `-` without a time. */
export function formatAge(value: TimeInput): string {
  const d = toDate(value)
  return d ? humanDuration((Date.now() - d.getTime()) / 1000) : '-'
}

/** `YYYY-MM-DD HH:mm:ss` in the viewer's time zone, `-` without a time. */
export function formatTime(value: TimeInput): string {
  const d = toDate(value)
  if (!d) return '-'
  return `${formatDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** `YYYY-MM-DD` in the viewer's time zone, `-` without a time. */
export function formatDate(value: TimeInput): string {
  const d = toDate(value)
  return d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : '-'
}

/** The UTC value for a tooltip (RFC 3339, as the API writes it). */
export function utcTitle(value: TimeInput): string | undefined {
  const d = toDate(value)
  return d ? d.toISOString().replace(/\.\d{3}Z$/, 'Z') : undefined
}

/** Tooltip of an age cell: the local time and the UTC value. */
export function absoluteTitle(value: TimeInput): string | undefined {
  const utc = utcTitle(value)
  return utc ? `${formatTime(value)} · ${utc}` : undefined
}

/** A typed `YYYY-MM-DD` (or `YYYY-MM-DD HH:mm` with `withTime`) as a local Date, null when it is not one. */
export function parseTypedTime(text: string, withTime = false): Date | null {
  const m = withTime
    ? /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(text.trim())
    : /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim())
  if (!m) return null
  const [y, mo, d, h = '0', mi = '0'] = m.slice(1)
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi))
  // 2026-02-31 rolls over to March: not a real date
  if (date.getFullYear() !== Number(y) || date.getMonth() !== Number(mo) - 1 || date.getDate() !== Number(d)) return null
  if (date.getHours() !== Number(h) || date.getMinutes() !== Number(mi)) return null
  return date
}
