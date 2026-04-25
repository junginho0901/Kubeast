import { useState, useMemo, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  Clock,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  ArrowUpCircle,
  ChevronDown,
} from 'lucide-react'
import { api, TimelineEvent, RolloutRevision } from '@/services/api'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import { useAIContext } from '@/hooks/useAIContext'

const TIME_RANGES = [
  { value: 1, label: '1h' },
  { value: 6, label: '6h' },
  { value: 24, label: '24h' },
  { value: 168, label: '7d' },
] as const

type EventFilter = 'all' | 'Normal' | 'Warning'

function fmtRelative(iso: string): string {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}

function fmtAbsolute(iso: string): string {
  if (!iso) return ''
  return new Date(iso).toLocaleString()
}

function getDateKey(iso: string): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString()
}

type TimelineItem =
  | { type: 'event'; data: TimelineEvent; timestamp: string }
  | { type: 'rollout'; data: RolloutRevision; timestamp: string }

export default function Timeline() {
  const { t } = useTranslation()
  const { open: openDetail } = useResourceDetail()

  const [selectedNamespace, setSelectedNamespace] = useState<string>('')
  const [hours, setHours] = useState(24)
  const [eventFilter, setEventFilter] = useState<EventFilter>('all')
  const [showCount, setShowCount] = useState(50)

  const { data: namespaces } = useQuery({
    queryKey: ['namespaces'],
    queryFn: () => api.getNamespaces(),
    staleTime: 30000,
  })

  const namespace = selectedNamespace || (namespaces?.[0] as any)?.name || 'default'

  const { data: timeline, isLoading, refetch } = useQuery({
    queryKey: ['timeline', namespace, hours],
    queryFn: () => api.getNamespaceTimeline(namespace, hours),
    enabled: !!namespace,
    staleTime: 15000,
  })

  // Merge events + rollouts into a single sorted timeline
  const mergedItems = useMemo<TimelineItem[]>(() => {
    if (!timeline) return []
    const items: TimelineItem[] = []

    for (const e of timeline.events) {
      if (eventFilter !== 'all' && e.type !== eventFilter) continue
      items.push({ type: 'event', data: e, timestamp: e.timestamp })
    }

    if (eventFilter === 'all') {
      for (const r of timeline.rollout_history) {
        items.push({ type: 'rollout', data: r, timestamp: r.created_at })
      }
    }

    items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    return items
  }, [timeline, eventFilter])

  const visibleItems = mergedItems.slice(0, showCount)
  const hasMore = mergedItems.length > showCount

  // 플로팅 AI 위젯용 스냅샷
  const aiSnapshot = useMemo(() => {
    if (!timeline) return null
    const totalEvents = timeline.events?.length ?? 0
    const totalRollouts = timeline.rollout_history?.length ?? 0
    const warnings = timeline.events?.filter((e) => e.type === 'Warning').length ?? 0
    const prefix = warnings > 0 ? '⚠️ ' : ''
    return {
      source: 'base' as const,
      summary: `${prefix}타임라인 · ${namespace} · 최근 ${hours}h · 이벤트 ${totalEvents}, 롤아웃 ${totalRollouts}${warnings ? `, Warning ${warnings}` : ''}`,
      data: {
        filters: { namespace, hours, event_filter: eventFilter },
        stats: { total_events: totalEvents, total_rollouts: totalRollouts, warnings },
        recent_items: visibleItems.slice(0, 15).map((it) =>
          it.type === 'event'
            ? {
                kind: 'event',
                event_type: (it.data as TimelineEvent).type,
                reason: (it.data as TimelineEvent).reason,
                message: (it.data as TimelineEvent).message,
                involved_object: (it.data as TimelineEvent).involved_object,
                timestamp: it.timestamp,
              }
            : {
                kind: 'rollout',
                resource_kind: (it.data as RolloutRevision).kind,
                resource_name: (it.data as RolloutRevision).name,
                revision: (it.data as RolloutRevision).revision,
                cause: (it.data as RolloutRevision).change_cause,
                timestamp: it.timestamp,
              },
        ),
      },
    }
  }, [timeline, namespace, hours, eventFilter, visibleItems])

  useAIContext(aiSnapshot, [aiSnapshot])

  const handleResourceClick = useCallback((kind: string, name: string, ns: string) => {
    openDetail({ kind, name, namespace: ns })
  }, [openDetail])

  // Collect unique namespaces from the list
  const namespaceOptions = useMemo(() => {
    if (!namespaces) return []
    return (namespaces as any[]).map((n: any) => n.name).sort()
  }, [namespaces])

  return (
    <div className="space-y-4">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-gray-900 dark:text-white">
          {t('timeline.title', 'Change History Timeline')}
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          {t('timeline.subtitle', 'View K8s events and resource changes in chronological order.')}
        </p>
      </div>

      {/* Filter Bar */}
      <div className="flex flex-wrap items-center gap-3 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-3">
        {/* Namespace */}
        <div className="relative">
          <select
            value={namespace}
            onChange={(e) => { setSelectedNamespace(e.target.value); setShowCount(50) }}
            className="appearance-none bg-gray-50 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 text-sm rounded-md pl-3 pr-8 py-1.5 text-gray-900 dark:text-white focus:ring-blue-500 focus:border-blue-500"
          >
            {namespaceOptions.map((ns: string) => (
              <option key={ns} value={ns}>{ns}</option>
            ))}
          </select>
          <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
        </div>

        {/* Time Range */}
        <div className="flex items-center gap-1 bg-gray-100 dark:bg-gray-700 rounded-md p-0.5">
          {TIME_RANGES.map((tr) => (
            <button
              key={tr.value}
              onClick={() => { setHours(tr.value); setShowCount(50) }}
              className={`px-2.5 py-1 text-xs font-medium rounded transition-colors ${
                hours === tr.value
                  ? 'bg-white dark:bg-gray-600 text-blue-600 dark:text-blue-400 shadow-sm'
                  : 'text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white'
              }`}
            >
              {t(`timeline.${tr.label}`, tr.label)}
            </button>
          ))}
        </div>

        {/* Event Type Filter */}
        <div className="flex items-center gap-1 bg-gray-100 dark:bg-gray-700 rounded-md p-0.5">
          {(['all', 'Normal', 'Warning'] as EventFilter[]).map((f) => (
            <button
              key={f}
              onClick={() => setEventFilter(f)}
              className={`px-2.5 py-1 text-xs font-medium rounded transition-colors ${
                eventFilter === f
                  ? 'bg-white dark:bg-gray-600 text-blue-600 dark:text-blue-400 shadow-sm'
                  : 'text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white'
              }`}
            >
              {t(`timeline.${f.toLowerCase()}`, f)}
            </button>
          ))}
        </div>

        <div className="flex-1" />

        {/* Refresh */}
        <button
          onClick={() => refetch()}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-gray-50 dark:bg-gray-700 text-gray-700 dark:text-gray-300 border border-gray-200 dark:border-gray-600 rounded-md hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors"
          title={t('timeline.refresh', 'Refresh')}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Summary Cards */}
      {timeline && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <SummaryCard
            label={t('timeline.totalEvents', 'Total Events')}
            value={timeline.summary.total_events}
            color="blue"
          />
          <SummaryCard
            label={t('timeline.normalEvents', 'Normal Events')}
            value={timeline.summary.normal_count}
            color="green"
          />
          <SummaryCard
            label={t('timeline.warningEvents', 'Warning Events')}
            value={timeline.summary.warning_count}
            color="yellow"
          />
          <SummaryCard
            label={t('timeline.rollouts', 'Rollouts')}
            value={timeline.rollout_history.length}
            color="blue"
          />
        </div>
      )}

      {/* Timeline */}
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg">
        {isLoading ? (
          <div className="flex items-center justify-center py-20">
            <RefreshCw className="w-5 h-5 animate-spin text-gray-400" />
          </div>
        ) : visibleItems.length === 0 ? (
          <div className="text-center py-16">
            <Clock className="w-10 h-10 text-gray-300 dark:text-gray-600 mx-auto mb-3" />
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {t('timeline.noEvents', 'No events in this period')}
            </p>
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
              {t('timeline.noEventsHint', 'K8s events typically have a ~1 hour TTL.')}
            </p>
          </div>
        ) : (
          <div className="relative">
            {/* Vertical line */}
            <div className="absolute left-[140px] top-0 bottom-0 w-px bg-gray-200 dark:bg-gray-700 hidden md:block" />

            <div className="divide-y divide-gray-100 dark:divide-gray-700/50">
              {visibleItems.map((item, idx) => {
                const prevItem = idx > 0 ? visibleItems[idx - 1] : null
                const showDateSep = !prevItem || getDateKey(item.timestamp) !== getDateKey(prevItem.timestamp)

                return (
                  <div key={idx}>
                    {showDateSep && (
                      <div className="px-4 py-2 bg-gray-50 dark:bg-gray-800/80">
                        <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
                          {getDateKey(item.timestamp)}
                        </span>
                      </div>
                    )}
                    {item.type === 'event' ? (
                      <EventRow
                        event={item.data}
                        onResourceClick={handleResourceClick}
                        t={t}
                      />
                    ) : (
                      <RolloutRow
                        rollout={item.data}
                        onResourceClick={handleResourceClick}
                        t={t}
                      />
                    )}
                  </div>
                )
              })}
            </div>

            {/* Load More */}
            {hasMore && (
              <div className="p-3 text-center border-t border-gray-100 dark:border-gray-700/50">
                <button
                  onClick={() => setShowCount((c) => c + 50)}
                  className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300"
                >
                  {t('timeline.loadMore', 'Load More')} ({mergedItems.length - showCount} remaining)
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function SummaryCard({ label, value, color }: { label: string; value: number; color: 'blue' | 'green' | 'yellow' }) {
  const colors = {
    blue: 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800',
    green: 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300 border-green-200 dark:border-green-800',
    yellow: 'bg-yellow-50 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-300 border-yellow-200 dark:border-yellow-800',
  }
  return (
    <div className={`border rounded-lg p-3 ${colors[color]}`}>
      <p className="text-xs opacity-70">{label}</p>
      <p className="text-2xl font-bold mt-0.5">{value}</p>
    </div>
  )
}

function EventRow({
  event,
  onResourceClick,
  t,
}: {
  event: TimelineEvent
  onResourceClick: (kind: string, name: string, ns: string) => void
  t: any
}) {
  const isWarning = event.type === 'Warning'
  return (
    <div className="flex items-start gap-3 px-4 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors group">
      {/* Time */}
      <div className="w-[120px] flex-shrink-0 text-right hidden md:block">
        <span
          className="text-xs text-gray-400 dark:text-gray-500 cursor-default"
          title={fmtAbsolute(event.timestamp)}
        >
          {fmtRelative(event.timestamp)}
        </span>
      </div>

      {/* Icon */}
      <div className="flex-shrink-0 mt-0.5">
        {isWarning ? (
          <AlertTriangle className="w-4 h-4 text-yellow-500" />
        ) : (
          <CheckCircle2 className="w-4 h-4 text-green-500" />
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-gray-900 dark:text-white">
            {event.reason}
          </span>
          {event.count > 1 && (
            <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 rounded">
              {t('timeline.repeated', '{{count}} times').replace('{{count}}', String(event.count))}
            </span>
          )}
          <span className="text-xs text-gray-400 dark:text-gray-500 md:hidden">
            {fmtRelative(event.timestamp)}
          </span>
        </div>
        <p className="text-xs text-gray-600 dark:text-gray-400 mt-0.5 break-words">
          {event.message}
        </p>
        <div className="flex items-center gap-2 mt-1">
          <button
            onClick={() => onResourceClick(event.resource.kind, event.resource.name, event.resource.namespace)}
            className="text-[11px] text-blue-600 dark:text-blue-400 hover:underline"
          >
            {event.resource.kind}/{event.resource.name}
          </button>
          {event.source && (
            <span className="text-[11px] text-gray-400 dark:text-gray-500">
              via {event.source}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

function RolloutRow({
  rollout,
  onResourceClick,
  t,
}: {
  rollout: RolloutRevision
  onResourceClick: (kind: string, name: string, ns: string) => void
  t: any
}) {
  return (
    <div className="flex items-start gap-3 px-4 py-2.5 bg-blue-50/50 dark:bg-blue-900/10 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors">
      {/* Time */}
      <div className="w-[120px] flex-shrink-0 text-right hidden md:block">
        <span
          className="text-xs text-gray-400 dark:text-gray-500 cursor-default"
          title={fmtAbsolute(rollout.created_at)}
        >
          {fmtRelative(rollout.created_at)}
        </span>
      </div>

      {/* Icon */}
      <div className="flex-shrink-0 mt-0.5">
        <ArrowUpCircle className="w-4 h-4 text-blue-500" />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-blue-800 dark:text-blue-300">
            {t('timeline.revision', 'Revision')} #{rollout.revision}
          </span>
          <span className="text-xs text-gray-400 dark:text-gray-500 md:hidden">
            {fmtRelative(rollout.created_at)}
          </span>
        </div>
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          <button
            onClick={() => onResourceClick(rollout.kind, rollout.name, rollout.namespace)}
            className="text-[11px] text-blue-600 dark:text-blue-400 hover:underline"
          >
            {rollout.kind}/{rollout.name}
          </button>
          <span className="text-[11px] text-gray-500 dark:text-gray-400">
            {rollout.images.join(', ')}
          </span>
        </div>
        {rollout.change_cause && (
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            {t('timeline.changeCause', 'Change Cause')}: {rollout.change_cause}
          </p>
        )}
      </div>
    </div>
  )
}
