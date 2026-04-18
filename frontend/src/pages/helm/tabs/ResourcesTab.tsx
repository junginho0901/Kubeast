import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { api } from '@/services/api'

export default function ResourcesTab({ namespace, name }: { namespace: string; name: string }) {
  const { t } = useTranslation()
  const q = useQuery({
    queryKey: ['helm-resources', namespace, name],
    queryFn: () => api.helm.getResources(namespace, name),
    enabled: !!namespace && !!name,
  })

  if (q.isLoading) {
    return (
      <div className="flex items-center justify-center py-10 text-slate-400">
        <Loader2 className="w-5 h-5 animate-spin" />
      </div>
    )
  }

  const items = q.data ?? []
  if (items.length === 0) {
    return <div className="text-sm text-slate-400">{t('helmReleaseDetail.resources.empty')}</div>
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-700">
      <table className="w-full text-sm">
        <thead className="bg-slate-800 text-slate-300 text-left">
          <tr>
            <th className="px-3 py-2">Kind</th>
            <th className="px-3 py-2">API Version</th>
            <th className="px-3 py-2">Name</th>
            <th className="px-3 py-2">Namespace</th>
          </tr>
        </thead>
        <tbody className="bg-slate-900/40 divide-y divide-slate-800">
          {items.map((r, i) => (
            <tr key={`${r.kind}/${r.namespace ?? ''}/${r.name}/${i}`} className="hover:bg-slate-800/60">
              <td className="px-3 py-2 text-white">{r.kind}</td>
              <td className="px-3 py-2 text-slate-400">{r.apiVersion}</td>
              <td className="px-3 py-2 text-slate-300">{r.name}</td>
              <td className="px-3 py-2 text-slate-300">{r.namespace ?? '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
