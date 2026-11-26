import { useTranslation } from 'react-i18next'
import { Radio } from 'lucide-react'
import { useAIContext } from '@/hooks/useAIContext'
import { useForbiddenLists } from '@/services/forbiddenStore'
import { useWatchProblem } from '@/services/watchProblemStore'

// Shown above the page when a list on it stopped following the cluster (services/watchProblemStore), and told to the
// floating chat. A list the page was told it may not read has no rows to go old; another list refused beside it says
// nothing of these rows.
export default function WatchProblemNotice() {
  const { t } = useTranslation()
  const problem = useWatchProblem(useForbiddenLists())
  const text = problem && {
    forbidden: t('layout.watchProblem.forbidden', 'The cluster refuses live updates for part of this page. Rows may be out of date; refresh to read them again.'),
    limit: t('layout.watchProblem.limit', 'This tab follows as many lists as one tab may. The rest are read about once a minute and go back to live updates by themselves when this tab has room.'),
    server_limit: t('layout.watchProblem.serverLimit', 'The server follows as many lists as it can. The rows on this page are read about once a minute and go back to live updates by themselves when it has room.'),
    server_memory: t('layout.watchProblem.serverMemory', 'The server is short of memory, so it starts following no more lists for now. The rows on this page are read about once a minute and go back to live updates by themselves when it has room.'),
    unreachable: t('layout.watchProblem.unreachable', 'The cluster cannot be reached, so live updates are paused. They come back by themselves.'),
    failed: t('layout.watchProblem.failed', 'Live updates are paused because the cluster answered with an error. They come back by themselves.'),
    scope: t('layout.watchProblem.scope', 'Your access is limited to namespaces, so objects of the whole cluster on this page do not update live. Rows may be out of date; refresh to read them again.'),
    server_opening: t('layout.watchProblem.serverOpening', 'Many live lists are opening, a few at a time, so live updates for this page wait for their turn. They start by themselves shortly and read the rows again then.'),
  }[problem]
  // a list waiting for its turn to open has not stopped: it starts by itself
  const liveUpdates = problem === 'server_opening' ? 'waiting' : 'stopped'
  useAIContext(problem && text ? { source: 'WatchProblemNotice', summary: text, data: { live_updates: liveUpdates, reason: problem } } : null, [problem, text])
  if (!problem) return null
  return (
    <div
      role="status"
      data-testid="watch-problem-notice"
      data-problem={problem}
      className="mb-4 flex items-start gap-3 rounded-lg border border-notice-border-warning/50 bg-notice-surface-warning/20 px-4 py-3 text-sm text-amber-200"
    >
      <Radio className="mt-0.5 h-4 w-4 shrink-0 text-notice-icon-warning" />
      <div className="min-w-0 [overflow-wrap:anywhere]">{text}</div>
    </div>
  )
}
