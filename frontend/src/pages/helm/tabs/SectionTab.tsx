import { useQuery } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { api, type HelmSection } from '@/services/api'

// Generic read-only renderer for the manifest / notes tabs. Values has
// its own tab because it gains an edit mode in v1.1 (see ValuesTab).
//
// Manifest can easily be thousands of lines, so we swap <pre> for
// Monaco — code folding collapses each K8s document to a single line
// and the minimap lets you jump through a big manifest at a glance.
export default function SectionTab({
  namespace,
  name,
  section,
}: {
  namespace: string
  name: string
  section: HelmSection
}) {
  const q = useQuery({
    queryKey: ['helm-section', namespace, name, section],
    queryFn: () => api.helm.getSection(namespace, name, section),
    enabled: !!namespace && !!name,
  })

  if (q.isLoading) {
    return (
      <div className="flex items-center justify-center py-10 text-slate-400">
        <Loader2 className="w-5 h-5 animate-spin" />
      </div>
    )
  }

  const content = q.data?.content ?? ''
  // notes can be markdown-ish with special chars and rarely needs
  // folding; keep the simple <pre> path for that section.
  if (section === 'notes') {
    return (
      <pre className="max-h-[70vh] overflow-auto rounded-lg bg-slate-900 border border-slate-700 px-4 py-3 text-xs text-slate-200 whitespace-pre-wrap">
        {content || '—'}
      </pre>
    )
  }

  return (
    <pre className="max-h-[70vh] overflow-auto rounded-lg bg-slate-900 border border-slate-700 px-4 py-3 text-xs text-slate-200 whitespace-pre">
      {content || '—'}
    </pre>
  )
}
