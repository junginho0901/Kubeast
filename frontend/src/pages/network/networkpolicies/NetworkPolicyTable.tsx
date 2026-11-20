// NetworkPolicy 목록 테이블 + sort 헤더 + pagination
//
// frontend/src/pages/network/NetworkPolicies.tsx 의 table JSX (sort header +
// tbody + 빈/로딩 상태 + pagination footer) 추출. useAdaptiveTable 의
// ref/rowsPerPage 는 부모에서 hook 호출 후 props 로 전달 (DOM 연결을 위해).

import type { Dispatch, RefObject, SetStateAction } from 'react'
import { ChevronDown, ChevronUp, Loader2 } from 'lucide-react'
import type { NetworkPolicyInfo } from '@/services/api'
import { AdaptiveTableFillerRows } from '@/components/AdaptiveTableFillerRows'
import { ListPager } from '@/components/ListPager'
import { TableEmptyRow } from '@/components/TableEmptyRow'
import {
  formatAge,
  formatDefaultDeny,
  formatPolicyTypes,
  formatSelector,
  networkPolicyToRawJson,
  type SortKey,
} from './networkPolicyHelpers'
import { Trans } from 'react-i18next'
import { openOnPress } from '@/components/openOnPress'
import { SortButton } from '@/components/SortButton'

interface OpenDetailArgs {
  kind: string
  name: string
  namespace: string
  rawJson?: Record<string, unknown>
}

interface Props {
  pagedPolicies: NetworkPolicyInfo[]
  sortedPoliciesLength: number
  isLoading: boolean
  showNamespaceColumn: boolean
  sortKey: SortKey
  setSortKey: Dispatch<SetStateAction<SortKey>>
  sortDir: 'asc' | 'desc'
  setSortDir: Dispatch<SetStateAction<'asc' | 'desc'>>
  currentPage: number
  setCurrentPage: Dispatch<SetStateAction<number>>
  searching?: boolean
  totalPages: number
  rowsPerPage: number
  tableContainerRef: RefObject<HTMLDivElement | null>
  tableBodyRef: RefObject<HTMLDivElement | null>
  theadRef: RefObject<HTMLTableSectionElement | null>
  firstRowRef: RefObject<HTMLTableRowElement | null>
  openDetail: (args: OpenDetailArgs) => void
  tr: (key: string, fallback: string, options?: Record<string, any>) => string
}

export function NetworkPolicyTable({
  pagedPolicies,
  sortedPoliciesLength,
  isLoading,
  showNamespaceColumn,
  sortKey,
  setSortKey,
  sortDir,
  setSortDir,
  currentPage,
  setCurrentPage,
  searching,
  totalPages,
  rowsPerPage,
  tableContainerRef,
  tableBodyRef,
  theadRef,
  firstRowRef,
  openDetail,
  tr,
}: Props) {
  const handleSort = (key: NonNullable<SortKey>) => {
    if (sortKey !== key) {
      setSortKey(key)
      setSortDir('asc')
      return
    }
    if (sortDir === 'asc') {
      setSortDir('desc')
      return
    }
    setSortKey(null)
  }

  const renderSortIcon = (key: NonNullable<SortKey>) => {
    if (sortKey !== key) return null
    return sortDir === 'asc'
      ? <ChevronUp className="w-3.5 h-3.5 text-slate-300" />
      : <ChevronDown className="w-3.5 h-3.5 text-slate-300" />
  }

  return (
    <div ref={tableContainerRef} className="card flex-1 min-h-0 flex flex-col">
      <div ref={tableBodyRef} className="overflow-x-auto flex-1 min-h-0">
        <table className="w-full text-sm min-w-[1140px] table-fixed">
          <thead ref={theadRef} className="text-slate-400">
            <tr>
              {showNamespaceColumn && (
                <th className="col-low text-left py-3 px-4 w-[180px] cursor-pointer" onClick={() => handleSort('namespace')}>
                  <SortButton>{tr('networkPoliciesPage.table.namespace', 'Namespace')}{renderSortIcon('namespace')}</SortButton>
                </th>
              )}
              <th className="text-left py-3 px-4 w-[220px] cursor-pointer" onClick={() => handleSort('name')}>
                <SortButton>{tr('networkPoliciesPage.table.name', 'Name')}{renderSortIcon('name')}</SortButton>
              </th>
              <th className="text-left py-3 px-4 w-[280px] cursor-pointer" onClick={() => handleSort('podSelector')}>
                <SortButton>{tr('networkPoliciesPage.table.podSelector', 'Pod Selector')}{renderSortIcon('podSelector')}</SortButton>
              </th>
              <th className="text-left py-3 px-4 w-[170px] cursor-pointer" onClick={() => handleSort('types')}>
                <SortButton>{tr('networkPoliciesPage.table.types', 'Types')}{renderSortIcon('types')}</SortButton>
              </th>
              <th className="text-left py-3 px-4 w-[120px] cursor-pointer" onClick={() => handleSort('ingressRules')}>
                <SortButton>{tr('networkPoliciesPage.table.ingressRules', 'Ingress')}{renderSortIcon('ingressRules')}</SortButton>
              </th>
              <th className="text-left py-3 px-4 w-[120px] cursor-pointer" onClick={() => handleSort('egressRules')}>
                <SortButton>{tr('networkPoliciesPage.table.egressRules', 'Egress')}{renderSortIcon('egressRules')}</SortButton>
              </th>
              <th className="text-left py-3 px-4 w-[150px] cursor-pointer" onClick={() => handleSort('defaultDeny')}>
                <SortButton>{tr('networkPoliciesPage.table.defaultDeny', 'Default Deny')}{renderSortIcon('defaultDeny')}</SortButton>
              </th>
              <th className="col-low text-left py-3 px-4 w-[90px] cursor-pointer" onClick={() => handleSort('age')}>
                <SortButton>{tr('networkPoliciesPage.table.age', 'Age')}{renderSortIcon('age')}</SortButton>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {pagedPolicies.map((policy, idx) => (
              <tr
                    ref={idx === 0 ? firstRowRef : undefined}
                key={`${policy.namespace}/${policy.name}`}
                className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                {...openOnPress(() => openDetail({
                  kind: 'NetworkPolicy',
                  name: policy.name,
                  namespace: policy.namespace,
                  rawJson: networkPolicyToRawJson(policy),
                }))}
              >
                {showNamespaceColumn && <td className="col-low py-3 px-4 text-xs font-mono" title={policy.namespace}><span className="block truncate">{policy.namespace}</span></td>}
                <td className="py-3 px-4 font-medium text-ink"><span className="block truncate">{policy.name}</span></td>
                <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{formatSelector(policy)}</span></td>
                <td className="py-3 px-4 text-xs"><span className="block truncate">{formatPolicyTypes(policy)}</span></td>
                <td className="py-3 px-4 text-xs font-mono">{policy.ingress_rules || 0}</td>
                <td className="py-3 px-4 text-xs font-mono">{policy.egress_rules || 0}</td>
                <td className="py-3 px-4 text-xs"><span className="block truncate">{formatDefaultDeny(policy)}</span></td>
                <td className="col-low py-3 px-4 text-xs font-mono">{formatAge(policy.created_at)}</td>
              </tr>
            ))}
            {isLoading && (
              <tr>
                <td colSpan={showNamespaceColumn ? 8 : 7} className="py-10 px-4 text-center text-slate-400">
                  <div className="inline-flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    
                    <Trans i18nKey="common.loading" />
                  </div>
                </td>
              </tr>
            )}

            {sortedPoliciesLength === 0 && !isLoading && (
              <TableEmptyRow colSpan={showNamespaceColumn ? 8 : 7} resource="networkpolicies" searching={searching} />
            )}
          </tbody>
            <AdaptiveTableFillerRows count={rowsPerPage - pagedPolicies.length} columnCount={7 + (showNamespaceColumn ? 1 : 0)} />
        </table>
      </div>

      <ListPager currentPage={currentPage} totalPages={totalPages} total={sortedPoliciesLength} rowsPerPage={rowsPerPage} onPageChange={setCurrentPage} />
    </div>
  )
}
