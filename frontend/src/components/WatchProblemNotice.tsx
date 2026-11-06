import { useTranslation } from 'react-i18next'
import { Radio } from 'lucide-react'
import { useForbiddenLabels } from '@/services/forbiddenStore'
import { useWatchProblem } from '@/services/watchProblemStore'

// Shown above the page when a list on it stopped following the cluster (services/watchProblemStore). A page already
// told it has no permission needs no second notice.
export default function WatchProblemNotice() {
  const { t } = useTranslation()
  const problem = useWatchProblem()
  const refused = useForbiddenLabels()
  if (!problem || refused.length > 0) return null
  const text = {
    forbidden: t('layout.watchProblem.forbidden', 'The cluster refuses live updates for part of this page. Rows may be out of date; refresh to read them again.'),
    limit: t('layout.watchProblem.limit', 'Too many lists are following the cluster for live updates. Rows may be out of date; close other tabs or refresh.'),
    unreachable: t('layout.watchProblem.unreachable', 'The cluster cannot be reached, so live updates are paused. They come back by themselves.'),
    failed: t('layout.watchProblem.failed', 'Live updates are paused because the cluster answered with an error. They come back by themselves.'),
  }[problem]
  return (
    <div
      role="status"
      data-testid="watch-problem-notice"
      data-problem={problem}
      className="mb-4 flex items-start gap-3 rounded-lg border border-amber-700/50 bg-amber-900/20 px-4 py-3 text-sm text-amber-100"
    >
      <Radio className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
      <div>{text}</div>
    </div>
  )
}
