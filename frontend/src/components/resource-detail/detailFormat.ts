// Time formatting helpers shared by the resource detail views.

export function fmtRel(iso?: string | null): string {
  if (!iso) return '-'
  const d = new Date(iso)
  const ms = Date.now() - d.getTime()
  if (!Number.isFinite(ms) || ms < 0) return '-'
  const m = Math.floor(ms / 60000)
  const h = Math.floor(m / 60)
  const days = Math.floor(h / 24)
  if (days >= 30) return `${Math.floor(days / 30)}mo`
  if (days > 0) return `${days}d`
  if (h > 0) return `${h}h`
  return `${m}m`
}

export function fmtTs(iso?: string | null): string {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '-'
  return d.toLocaleString()
}

export function fmtPodAge(iso?: string | null): string {
  if (!iso) return '-'
  const sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}
