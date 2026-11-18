import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ListPager } from '@/components/ListPager'
import { ModalFrame } from '@/components/ModalFrame'
import { modalButton } from '@/components/modalStyles'
import { useAIContext } from '@/hooks/useAIContext'
import type { AccessReviewRoleRow } from '@/services/api/access_review'
import { pageOf } from '@/utils/listPages'

const PER_PAGE = 10

// The report already holds every permission. Opening its window reads no other source.
export function AccessReviewRolePermissions({ role }: { role: AccessReviewRoleRow }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [page, setPage] = useState(1)
  const total = role.permissions.length
  const shown = pageOf(role.permissions, page, PER_PAGE)
  const count = t('accessReview.rolePermissions.count', { count: total, defaultValue: '{{count}} permissions' })
  const close = () => setOpen(false)

  // PageContextProvider still excludes all layers on this private admin screen.
  useAIContext(open ? {
    source: 'access-review-role-permissions',
    summary: `Role ${role.name}: ${total} permissions; page ${shown.page} of ${shown.pages}.`,
    data: { role: role.name, total, page: shown.page, page_size: PER_PAGE, permissions: shown.rows },
  } : null, [open, role.name, role.permissions, total, shown.page, shown.pages])

  return (
    <>
      {total === 0 ? <span className="font-mono text-[11px]">-</span> : (
        <button
          type="button"
          aria-haspopup="dialog"
          className="btn-row whitespace-nowrap tabular-nums"
          onClick={() => { setPage(1); setOpen(true) }}
        >
          {count}<span className="sr-only"> — {role.name}</span>
        </button>
      )}
      {open && (
        <ModalFrame
          size="md"
          body="fill"
          title={<>{role.name} — {t('accessReview.col.permissions', 'Permissions')}</>}
          subtitle={t('accessReview.rolePermissions.description', { count: total, defaultValue: 'Permissions in this role: {{count}}.' })}
          onClose={close}
          testId="access-review-role-permissions"
          footer={<button type="button" onClick={close} className={modalButton.cancel}>{t('common.close', 'Close')}</button>}
        >
          <div className="min-h-0 flex flex-col rounded-lg border border-hairline overflow-hidden">
            <div className="min-h-0 overflow-y-auto">
              <ul data-list="Role permissions" className="divide-y divide-hairline">
                {shown.rows.map((permission, index) => (
                  <li key={`${shown.page}:${index}`} className="px-3 py-2 font-mono text-xs text-ink [overflow-wrap:anywhere]">{permission}</li>
                ))}
              </ul>
              {total === 0 && <p className="px-3 py-2 text-sm text-slate-400">{t('common.none', 'None')}</p>}
            </div>
            <ListPager
              currentPage={shown.page}
              totalPages={shown.pages}
              total={total}
              rowsPerPage={PER_PAGE}
              onPageChange={setPage}
              showPageSize={false}
              testId="access-review-role-permissions-pager"
            />
          </div>
        </ModalFrame>
      )}
    </>
  )
}
