import { Link } from 'react-router-dom'
import { Package, ArrowUpRight } from 'lucide-react'
import { extractHelmRelease } from './utils'

// HelmReleaseBadge surfaces the owning Helm release on any resource
// that was installed via Helm. Placed in the drawer header so users
// can jump from "why is this pod here?" to the Helm detail page in
// one click.
export function HelmReleaseBadge({ rawJson }: { rawJson: Record<string, unknown> | null | undefined }) {
  const rel = extractHelmRelease(rawJson)
  if (!rel) return null
  const to = `/helm/releases/${encodeURIComponent(rel.namespace)}/${encodeURIComponent(rel.name)}`
  return (
    <Link
      to={to}
      className="mt-1.5 inline-flex items-center gap-1.5 rounded-md border border-primary-500/40 bg-primary-500/10 px-2 py-0.5 text-xs text-primary-200 hover:bg-primary-500/20"
      title={`Helm release ${rel.namespace}/${rel.name}`}
    >
      <Package className="w-3 h-3" />
      <span className="font-medium">{rel.name}</span>
      <span className="text-primary-400/80">·</span>
      <span className="text-primary-300/90">{rel.namespace}</span>
      <ArrowUpRight className="w-3 h-3" />
    </Link>
  )
}
