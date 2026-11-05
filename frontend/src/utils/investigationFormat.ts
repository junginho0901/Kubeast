import { formatTime } from './time'

// Shared by Admin → Investigations, the report window and the Alerts inbox.

export const statusClass: Record<string, string> = {
  queued: 'bg-slate-800/60 text-slate-300 border-slate-600',
  running: 'bg-primary-900/40 text-primary-300 border-primary-800/60',
  done: 'bg-emerald-900/40 text-emerald-300 border-emerald-800/60',
  failed: 'bg-red-900/40 text-red-300 border-red-800/60',
  skipped: 'bg-amber-900/40 text-amber-300 border-amber-800/60',
}

export const severityClass: Record<string, string> = {
  critical: 'text-red-300',
  warning: 'text-amber-300',
}

export function duration(ms: number | null): string {
  if (ms === null || ms === undefined) return '-'
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}

type Tr = (key: string, fallback: string, opts?: Record<string, unknown>) => string

export interface SkipReason {
  skip_reason?: string
  skip_reason_key?: string
  skip_reason_args?: Record<string, string | number>
}

// Why an investigation was skipped, in the reader's language: the label ("Skipped by the investigation limit") and
// the sentence with the server's numbers. A reason without a catalog key (written another way) shows as the server
// wrote it, under the old "Skipped: …" label.
export function skipReason(r: SkipReason, tr: Tr): { label: string; why: string; text: string } {
  const raw = r.skip_reason ?? ''
  if (!r.skip_reason_key) {
    const text = tr('investigations.skipReason', 'Skipped: {{reason}}', { reason: raw })
    return { label: text, why: '', text }
  }
  const args: Record<string, unknown> = { ...(r.skip_reason_args ?? {}) }
  for (const k of ['at', 'until']) if (typeof args[k] === 'string') args[k] = formatTime(args[k] as string)
  const label = tr(`investigations.skip.${r.skip_reason_key}`, tr('investigations.status.skipped', 'Skipped'))
  const why = tr(`investigations.skipWhy.${r.skip_reason_key}`, raw, args)
  return { label, why, text: `${label} — ${why}` }
}
