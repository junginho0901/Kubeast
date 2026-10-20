// Shared by Admin → Investigations, the report window and the Alerts inbox.

export const statusClass: Record<string, string> = {
  queued: 'bg-slate-800/60 text-slate-300 border-slate-600',
  running: 'bg-sky-900/40 text-sky-300 border-sky-800/60',
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
