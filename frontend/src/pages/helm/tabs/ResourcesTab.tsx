import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { api } from '@/services/api'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import { ListPager } from '@/components/ListPager'
import { useAdaptiveTable } from '@/hooks/useAdaptiveTable'
import { usePagedItems } from '@/hooks/usePagedItems'
import { failureText } from '@/utils/failureText'
import { classifyReadFailure } from '@/utils/aiContext/readFailure'
import { forbiddenResourceFromUrl } from '@/utils/forbiddenResource'

const NO_RESOURCES: never[] = []

export default function ResourcesTab({ namespace, name }: { namespace: string; name: string }) {
  const { t } = useTranslation()
  const { open } = useResourceDetail()
  const q = useQuery({
    queryKey: ['helm-resources', namespace, name],
    queryFn: () => api.helm.getResources(namespace, name),
    enabled: !!namespace && !!name,
  })

  // a big chart makes hundreds of objects: a page at a time, fitted to the screen as the list pages
  const items = q.data ?? NO_RESOURCES
  const { containerRef, bodyRef, theadRef, firstRowRef, rowsPerPage } = useAdaptiveTable({ recalculationKey: items.length })
  const { items: paged, page, totalPages, total, setPage } = usePagedItems(items, rowsPerPage, `${namespace}/${name}`)

  if (q.isLoading) {
    return (
      <div className="flex items-center justify-center py-10 text-slate-400">
        <Loader2 className="w-5 h-5 animate-spin" />
      </div>
    )
  }

  // a read that failed is not a release with no objects: its reason, as a list says it, and a refusal as the lists say
  // one (the tab's layer says `resources_refused`)
  if (q.isError && !q.data) {
    const refused = classifyReadFailure(q.error).refused
    return (
      <p role="alert" data-testid={refused ? 'helm-resources-refused' : 'helm-resources-read-failed'} className="text-sm text-red-400 break-words">
        {refused
          ? t('common.forbiddenEmpty', { defaultValue: 'You do not have permission to view {{resource}} in this cluster.', resource: forbiddenResourceFromUrl('/cluster/helm/releases') })
          : t('common.readFailed', { defaultValue: 'Could not read the list: {{reason}}', reason: failureText(q.error) })}
      </p>
    )
  }

  if (items.length === 0) {
    return <div className="text-sm text-slate-400">{t('helmReleaseDetail.resources.empty')}</div>
  }

  return (
    <div ref={containerRef} className="flex-1 min-h-0 flex flex-col rounded-xl border border-hairline">
      <div ref={bodyRef} className="overflow-auto flex-1 min-h-0">
        <table className="w-full text-sm">
          <thead ref={theadRef} className="bg-slate-800 text-slate-300 text-left">
            <tr>
              <th className="px-3 py-2">{t('helmReleaseDetail.resources.col.kind', 'Kind')}</th>
              <th className="px-3 py-2">API Version</th>
              <th className="px-3 py-2">{t('helmReleaseDetail.resources.col.name', 'Name')}</th>
              <th className="px-3 py-2">{t('helmReleaseDetail.resources.col.namespace', 'Namespace')}</th>
            </tr>
          </thead>
          <tbody className="bg-slate-900/40 divide-y divide-hairline">
            {paged.map((r, i) => (
              <tr
                key={`${r.kind}/${r.namespace ?? ''}/${r.name}/${i}`}
                ref={i === 0 ? firstRowRef : undefined}
                className="hover:bg-slate-800/60 cursor-pointer"
                onClick={() =>
                  open({
                    kind: r.kind,
                    name: r.name,
                    namespace: r.namespace,
                    apiVersion: r.apiVersion,
                  })
                }
              >
                <td className="px-3 py-2 text-ink">{r.kind}</td>
                <td className="px-3 py-2 text-slate-400">{r.apiVersion}</td>
                <td className="px-3 py-2 text-slate-300">{r.name}</td>
                <td className="px-3 py-2 text-slate-300">{r.namespace ?? '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ListPager currentPage={page} totalPages={totalPages} total={total} rowsPerPage={rowsPerPage} onPageChange={setPage} testId="helm-resources-pager" />
    </div>
  )
}
