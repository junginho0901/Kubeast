import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { humanDuration } from '@/utils/time'
import type { MetricsRefreshFailure } from './metricsRefresh'

interface Props {
  failure: MetricsRefreshFailure
  // metrics are off for this cluster: nothing asks again
  retrying: boolean
  testId: string
}

export function MetricsRefreshFailed({ failure, retrying, testId }: Props) {
  const { t } = useTranslation()
  // its own clock, so the age moves without drawing the table again
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const age = humanDuration(Math.max(0, now - failure.valuesFrom) / 1000)
  return (
    <div role="status" data-testid={testId} className="mb-4 text-xs text-amber-300 p-2 bg-amber-500/10 border border-amber-500/20 rounded-lg break-keep">
      <p>
        {t('monitoring.refreshFailed', { age, defaultValue: 'Refresh failed. These values are from {{age}} ago.' })}
        {retrying && ` ${t('monitoring.pods.retrying')}`}
      </p>
      {failure.detail && <p className="mt-1 break-all text-slate-400">{failure.detail}</p>}
    </div>
  )
}
