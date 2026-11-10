import { Link } from 'react-router-dom'
import { Package, ArrowUpRight } from 'lucide-react'
import { useDetailLabel } from './useDetailLabel'
import { extractHelmRelease } from './utils'

// HelmReleaseBadge surfaces the owning Helm release on any resource
// that was installed via Helm. Placed in the drawer header so users
// can jump from "why is this pod here?" to the Helm detail page in
// one click.
export function HelmReleaseBadge({ rawJson }: { rawJson: Record<string, unknown> | null | undefined }) {
  const dl = useDetailLabel()
  const rel = extractHelmRelease(rawJson)
  if (!rel) return null
  const to = `/helm/releases/${encodeURIComponent(rel.namespace)}/${encodeURIComponent(rel.name)}`
  return (
    <Link
      to={to}
      className="mt-1.5 inline-flex max-w-full flex-wrap items-center gap-1.5 rounded-lg bg-slate-700/40 px-2 py-0.5 text-xs text-primary-400 hover:bg-slate-700"
      title={dl('Helm release {{release}}', { release: `${rel.namespace}/${rel.name}` })}
    >
      <Package className="w-3 h-3 shrink-0" />
      <span className="text-primary-400/80">Helm</span>
      <span className="font-medium break-all">{rel.name}</span>
      <span className="text-primary-400/80">·</span>
      <span className="text-slate-400 break-all">{rel.namespace}</span>
      <ArrowUpRight className="w-3 h-3 shrink-0" />
    </Link>
  )
}
