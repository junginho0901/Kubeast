import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useForbidden } from '@/services/forbiddenStore'
import { forbiddenResourceFromUrl } from '@/utils/forbiddenResource'

interface Props {
  colSpan: number
  /** API path segment of the list ("pods", "vpas", "rolebindings") — the one the 403 came back for */
  resource: string
  /** The page's own "No … found." text */
  children: ReactNode
  className?: string
}

// The empty row of a list table. When the list request answered 403 the row
// says so instead of "No … found." (which would read as "the cluster has
// none"); otherwise it renders the page's own empty text.
export function TableEmptyRow({ colSpan, resource, children, className = 'py-6 px-4 text-center text-slate-400' }: Props) {
  const { t } = useTranslation()
  const forbidden = useForbidden(resource)
  return (
    <tr>
      <td colSpan={colSpan} className={className} data-testid={forbidden ? 'table-forbidden' : undefined}>
        {forbidden
          ? t('common.forbiddenEmpty', {
              resource: forbiddenResourceFromUrl(`/cluster/${resource}`),
              defaultValue: 'You do not have permission to view {{resource}} in this cluster.',
            })
          : children}
      </td>
    </tr>
  )
}
