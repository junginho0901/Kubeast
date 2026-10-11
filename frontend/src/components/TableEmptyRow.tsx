import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { useForbidden } from '@/services/forbiddenStore'
import { useListStatus } from '@/services/listStatusStore'
import { forbiddenResourceFromUrl } from '@/utils/forbiddenResource'

interface Props {
  colSpan: number
  /** API path segment of the list ("pods", "vpas", "rolebindings") — the one the request was for */
  resource: string
  /** A search box has text: the row says no row matched instead of the list being empty */
  searching?: boolean
  /** Replaces the shared empty text (tables that are not a plain list) */
  children?: ReactNode
  className?: string
}

// The empty row of a list table. "No items" would read as "the cluster has
// none", so the row says what really happened when it knows: the kind is not
// installed on the cluster (its CRD is missing), the list failed on the
// server (with a retry), or the request answered 403. Otherwise one shared
// text: no items, or no search results while the search box has text.
export function TableEmptyRow({ colSpan, resource, searching = false, children, className = 'py-6 px-4 text-center text-slate-400' }: Props) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const forbidden = useForbidden(resource)
  const status = useListStatus(resource)
  const kind = forbiddenResourceFromUrl(`/cluster/${resource}`)

  let body: ReactNode =
    children ?? (searching ? t('common.noSearchResults', 'No results found.') : t('common.listEmpty', 'No items.'))
  let testId: string | undefined
  if (status?.state === 'notInstalled') {
    testId = 'table-not-installed'
    body = t('common.notInstalledEmpty', {
      resource: kind,
      defaultValue: '{{resource}} is not installed on this cluster (no CustomResourceDefinition).',
    })
  } else if (status?.state === 'error') {
    testId = 'table-load-error'
    body = (
      <>
        {status.code
          ? t('common.loadErrorEmpty', { resource: kind, code: status.code, defaultValue: 'Could not load {{resource}} (server error {{code}}).' })
          : t('common.loadErrorEmptyNetwork', { resource: kind, defaultValue: 'Could not load {{resource}} (no response from the server).' })}
        <button
          type="button"
          onClick={() => void queryClient.refetchQueries({ type: 'active' })}
          className="ml-3 rounded-sm border border-slate-600 px-2 py-0.5 text-xs text-slate-200 hover:border-slate-400"
          data-testid="table-load-error-retry"
        >
          {t('common.retry', { defaultValue: 'Retry' })}
        </button>
      </>
    )
  } else if (forbidden) {
    testId = 'table-forbidden'
    body = t('common.forbiddenEmpty', {
      resource: kind,
      defaultValue: 'You do not have permission to view {{resource}} in this cluster.',
    })
  }
  return (
    <tr>
      <td colSpan={colSpan} className={className} data-testid={testId}>
        {body}
      </td>
    </tr>
  )
}
