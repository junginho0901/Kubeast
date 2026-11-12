import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'

import { clearCreated, createdText, placeNotice, useCreatedNotice, useNoticePlaced, type CreatedObject } from '@/services/createdNoticeStore'

const SHOWN = 5

// Under a page's header (rendered by RefreshFailure, which every list page has there): what a Create from YAML made
// and what a delete removed on this page, until it is closed or another page opens. A page without that place (the
// Dashboard, Cluster View, the Resource Graph) gets it at the top from the layout (`fallback`), drawn only while no
// page draws its own. The page holding it unmounts when another opens, so the address is read as it is (no router
// needed where a page is drawn on its own); the layout's stays and is given the address.
export function CreatedNotice({ fallback = false, pathname: path }: { fallback?: boolean; pathname?: string } = {}) {
  const { t } = useTranslation()
  const pathname = path ?? (typeof window === 'undefined' ? '' : window.location.pathname)
  const notice = useCreatedNotice()
  const placed = useNoticePlaced()
  useEffect(() => (fallback ? undefined : placeNotice()), [fallback])
  const here = notice && notice.path === pathname ? notice : null
  useEffect(() => { if (notice && notice.path !== pathname) clearCreated() }, [notice, pathname])
  if (!here || (fallback && placed)) return null
  const names = (list: CreatedObject[]) => list.slice(0, SHOWN).map(createdText).join(', ')
    + (list.length > SHOWN ? ` ${t('yamlCreate.createdMore', { defaultValue: 'and {{count}} more', count: list.length - SHOWN })}` : '')
  return (
    <div role="status" data-testid="yaml-created" className={`shrink-0 flex items-start gap-3 text-sm text-emerald-300${fallback ? ' mb-4' : ''}`}>
      <div className="min-w-0">
        {here.objects.length > 0 && (
          <p className="break-words" title={here.objects.map(createdText).join('\n')}>
            {t('yamlCreate.created', { defaultValue: 'Created: {{objects}}', objects: names(here.objects) })}
          </p>
        )}
        {here.deleted.length > 0 && (
          <p className="break-words" data-testid="deleted-objects" title={here.deleted.map(createdText).join('\n')}>
            {t('common.deletedObjects', { defaultValue: 'Deleted: {{objects}}', objects: names(here.deleted) })}
          </p>
        )}
      </div>
      <button type="button" className="btn-row shrink-0" onClick={clearCreated} data-testid="yaml-created-close">
        {t('common.close', { defaultValue: 'Close' })}
      </button>
    </div>
  )
}
