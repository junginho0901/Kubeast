import type { HelmReleaseSummary } from '@/services/api'

export type SortKey =
  | null
  | 'name'
  | 'namespace'
  | 'revision'
  | 'status'
  | 'chart'
  | 'chartVersion'
  | 'appVersion'
  | 'updated'

export type SortDir = 'asc' | 'desc'

export type SummaryCard = [label: string, value: number, boxClass: string, labelClass: string]

// Empty state buttons point at Helm's public docs. The "install guide"
// link targets the subchapter most useful to a first-time user
// ("Installing Apps with Helm") rather than the manpage index.
export const HELM_DOCS_URL = 'https://helm.sh/docs/'
export const HELM_INSTALL_GUIDE_URL = 'https://helm.sh/docs/intro/using_helm/'

export function formatUpdated(iso: string): string {
  if (!iso) return '-'
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

export function statusBadge(status: string): string {
  const s = status.toLowerCase()
  if (s === 'deployed') return 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
  if (s === 'failed') return 'bg-red-500/15 text-red-300 border border-red-500/30'
  if (s.startsWith('pending')) return 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
  if (s === 'superseded') return 'bg-slate-500/15 text-slate-300 border border-slate-500/30'
  if (s.startsWith('uninstall')) return 'bg-slate-600/40 text-slate-300 border border-slate-600'
  return 'bg-slate-500/15 text-slate-300 border border-slate-500/30'
}

export function sortReleases(
  list: HelmReleaseSummary[],
  sortKey: SortKey,
  sortDir: SortDir,
): HelmReleaseSummary[] {
  if (!sortKey) return list
  const out = [...list]
  const getValue = (r: HelmReleaseSummary): string | number => {
    switch (sortKey) {
      case 'name':
        return r.name
      case 'namespace':
        return r.namespace
      case 'revision':
        return r.revision
      case 'status':
        return r.status
      case 'chart':
        return r.chart
      case 'chartVersion':
        return r.chartVersion
      case 'appVersion':
        return r.appVersion
      case 'updated':
        return r.updated ? new Date(r.updated).getTime() : 0
      default:
        return ''
    }
  }
  out.sort((a, b) => {
    const av = getValue(a)
    const bv = getValue(b)
    if (typeof av === 'number' && typeof bv === 'number') {
      return sortDir === 'asc' ? av - bv : bv - av
    }
    const as = String(av)
    const bs = String(bv)
    return sortDir === 'asc' ? as.localeCompare(bs) : bs.localeCompare(as)
  })
  return out
}
