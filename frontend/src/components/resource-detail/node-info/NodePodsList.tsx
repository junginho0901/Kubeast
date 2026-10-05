import { InfoSection, Th, Tx } from '../DetailCommon'
import { fmtPodAge } from '../detailFormat'
import { useDetailLabel } from '../useDetailLabel'
import { ResourceLink } from '../ResourceLink'

interface NodePodsListProps {
  podFilter: string
  setPodFilter: (v: string) => void
  filteredPods: any[]
  pagedPods: any[]
  podPage: number
  setPodPage: (updater: (p: number) => number) => void
  pageSize: number
  totalPages: number
  tr: (key: string, fallback: string, opts?: Record<string, any>) => string
}

export default function NodePodsList({
  podFilter,
  setPodFilter,
  filteredPods,
  pagedPods,
  podPage,
  setPodPage,
  pageSize,
  totalPages,
  tr,
}: NodePodsListProps) {
  const dl = useDetailLabel()
  return (
    <InfoSection
      title={tr('nodes.detail.pods', 'Pods')}
      actions={
        <input
          type="text"
          value={podFilter}
          onChange={e => setPodFilter(e.target.value)}
          placeholder={dl('Filter...')}
          className="bg-slate-800 border border-slate-700 rounded-md px-2 py-1 text-xs text-slate-200 placeholder:text-slate-500 w-36"
        />
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full text-xs min-w-[820px] table-fixed">
          <thead className="text-slate-400">
            <tr>
              <Th className="text-left py-2 w-[32%]">Name</Th>
              <Th className="text-left py-2 w-[16%]">Namespace</Th>
              <Th className="text-left py-2 w-[10%]">Ready</Th>
              <Th className="text-left py-2 w-[12%]">Status</Th>
              <Th className="text-left py-2 w-[10%]">Restarts</Th>
              <Th className="text-left py-2 w-[12%]">IP</Th>
              <Th className="text-left py-2 w-[8%]">Age</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {pagedPods.map((pod: any) => (
              <tr key={`${pod.namespace}-${pod.name}`} className="text-slate-200">
                <td className="py-2 pr-2 font-medium text-white"><span className="block truncate"><ResourceLink kind="Pod" name={pod.name} namespace={pod.namespace} /></span></td>
                <td className="py-2 pr-2"><span className="block truncate">{pod.namespace}</span></td>
                <td className="py-2 pr-2">{pod.ready || '-'}</td>
                <td className="py-2 pr-2"><span className="block truncate">{pod.status || pod.phase || '-'}</span></td>
                <td className="py-2 pr-2">{pod.restart_count ?? 0}</td>
                <td className="py-2 pr-2"><span className="block truncate">{pod.pod_ip || '-'}</span></td>
                <td className="py-2 pr-2">{fmtPodAge(pod.created_at)}</td>
              </tr>
            ))}
            {pagedPods.length === 0 && <tr><td colSpan={7} className="py-4 text-slate-400"><Tx>(none)</Tx></td></tr>}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between text-xs text-slate-400 pt-1 border-t border-slate-800 mt-2">
        <span>{filteredPods.length === 0 ? <Tx>(none)</Tx> : `${(podPage - 1) * pageSize + 1}-${Math.min(podPage * pageSize, filteredPods.length)} / ${filteredPods.length}`}</span>
        <div className="flex gap-2">
          <button onClick={() => setPodPage(p => Math.max(1, p - 1))} disabled={podPage === 1} className="px-2 py-1 rounded border border-slate-700 disabled:opacity-40"><Tx>Prev</Tx></button>
          <button onClick={() => setPodPage(p => Math.min(totalPages, p + 1))} disabled={podPage >= totalPages} className="px-2 py-1 rounded border border-slate-700 disabled:opacity-40"><Tx>Next</Tx></button>
        </div>
      </div>
    </InfoSection>
  )
}
