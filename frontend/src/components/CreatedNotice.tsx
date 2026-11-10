import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'

import { clearCreated, createdText, useCreatedNotice } from '@/services/createdNoticeStore'

const SHOWN = 5

// Under a page's header (rendered by RefreshFailure, which every list page has there): what a Create from YAML made
// on this page, until it is closed or another page opens. The page holding it unmounts when another opens, so the
// address is read as it is (no router needed where a page is drawn on its own).
export function CreatedNotice() {
  const { t } = useTranslation()
  const pathname = typeof window === 'undefined' ? '' : window.location.pathname
  const notice = useCreatedNotice()
  const here = notice && notice.path === pathname ? notice : null
  useEffect(() => { if (notice && notice.path !== pathname) clearCreated() }, [notice, pathname])
  const text = here
    ? t('yamlCreate.created', { defaultValue: 'Created: {{objects}}', objects: here.objects.slice(0, SHOWN).map(createdText).join(', ') })
      + (here.objects.length > SHOWN ? ` ${t('yamlCreate.createdMore', { defaultValue: 'and {{count}} more', count: here.objects.length - SHOWN })}` : '')
    : ''
  if (!here) return null
  return (
    <div role="status" data-testid="yaml-created" className="shrink-0 flex items-start gap-3 text-sm text-emerald-300">
      <p className="min-w-0 break-words" title={here.objects.map(createdText).join('\n')}>{text}</p>
      <button type="button" className="btn-row shrink-0" onClick={clearCreated} data-testid="yaml-created-close">
        {t('common.close', { defaultValue: 'Close' })}
      </button>
    </div>
  )
}
