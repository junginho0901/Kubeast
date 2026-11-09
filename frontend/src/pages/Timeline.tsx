import { useState, useMemo, useCallback, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  Clock,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  ArrowUpCircle,
} from 'lucide-react'
import { api, isForbiddenError, TimelineEvent, RolloutRevision } from '@/services/api'
import { forbiddenResourceFromUrl } from '@/utils/forbiddenResource'
import CustomDropdown from '@/components/CustomDropdown'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import { detailTarget } from '@/components/resource-detail/crDetail'
import { useAIContext } from '@/hooks/useAIContext'
import { useAdaptiveRowsPerPage } from '@/hooks/useAdaptiveRowsPerPage'
import { usePagedItems } from '@/hooks/usePagedItems'
import { ListPager } from '@/components/ListPager'
import { usePageSize } from '@/utils/pageSize'
import { absoluteTitle, formatAge, formatDate } from '@/utils/time'
import { rolloutsCount } from './timelineCards'

const TIME_RANGES = [
  { value: 1, label: '1h' },
  { value: 6, label: '6h' },
  { value: 24, label: '24h' },
  { value: 168, label: '7d' },
] as const

type EventFilter = 'all' | 'Normal' | 'Warning'

const fmtRelative = formatAge
// the local time with the UTC value after it (the tooltip of each row)
const fmtAbsolute = absoluteTitle
const getDateKey = formatDate

type TimelineItem =
  | { type: 'event'; data: TimelineEvent; timestamp: string }
  | { type: 'rollout'; data: RolloutRevision; timestamp: string }

export default function Timeline() {
  const { t } = useTranslation()
  const { open: openDetail } = useResourceDetail()

  const [selectedNamespace, setSelectedNamespace] = useState<string>('')
  const [hours, setHours] = useState(24)
  const [eventFilter, setEventFilter] = useState<EventFilter>('all')

  const { data: namespaces } = useQuery({
    queryKey: ['namespaces'],
    queryFn: () => api.getNamespaces(),
    staleTime: 30000,
  })

  // '' = every namespace (the default); a name narrows to that namespace.
  const namespace = selectedNamespace
  const allNamespaces = namespace === ''

  // the server lists the newest events of the type chosen, so a Warning list is the newest warnings, not the
  // warnings among the newest events
  const eventType = eventFilter === 'all' ? undefined : eventFilter
  const { data: timeline, isLoading, error, refetch } = useQuery({
    queryKey: ['timeline', allNamespaces ? '*' : namespace, hours, eventFilter],
    queryFn: () => (allNamespaces ? api.getClusterTimeline(hours, 500, eventType) : api.getNamespaceTimeline(namespace, hours, 500, eventType)),
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

  // A page of the window at a time in a box sized to the screen: Fit counts the rows the box holds (rows that wrap or
  // a date line take more, and the box scrolls inside), 25/50/100 draw that many.
  const listRef = useRef<HTMLDivElement>(null)
  const listBodyRef = useRef<HTMLDivElement>(null)
  const firstRowRef = useRef<HTMLDivElement>(null)
  const fitRows = useAdaptiveRowsPerPage(listRef, { bodyRef: listBodyRef, rowRef: firstRowRef, headerHeight: 0, recalculationKey: mergedItems.length })
  const pageSize = usePageSize()
  const rowsPerPage = pageSize === 'fit' ? fitRows : pageSize
  const { items: visibleItems, page, totalPages, total, setPage } = usePagedItems(mergedItems, rowsPerPage, `${namespace}|${hours}|${eventFilter}`)

  // 플로팅 AI 위젯용 스냅샷
  const aiSnapshot = useMemo(() => {
    if (!timeline) return null
    // the cards' numbers: every event of the window, not the ones listed
    const totalEvents = timeline.summary.total_events
    const totalRollouts = rolloutsCount(timeline)
    const warnings = timeline.summary.warning_count
    const prefix = warnings > 0 ? '⚠️ ' : ''
    return {
      source: 'base' as const,
      summary: `${prefix}타임라인 · ${allNamespaces ? '전체 네임스페이스' : namespace} · 최근 ${hours}h · 이벤트 ${totalEvents}, 롤아웃 ${totalRollouts ?? '못 읽음'}${warnings ? `, Warning ${warnings}` : ''}`,
      data: {
        filters: { namespace: allNamespaces ? '*' : namespace, hours, event_filter: eventFilter },
        stats: {
          total_events: totalEvents, total_rollouts: totalRollouts, warnings,
          listed_events: timeline.events?.length ?? 0, events_matching: timeline.summary.events_matching,
          rollouts_error: timeline.summary.rollouts_error,
        },
        // the page of the list on screen; recent_items stays the newest of the whole window, whichever page is open
        shown: { page, total_pages: totalPages, from: total === 0 ? 0 : (page - 1) * rowsPerPage + 1, to: Math.min(page * rowsPerPage, total), of: total },
        recent_items: mergedItems.slice(0, 15).map((it) =>
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
  }, [timeline, namespace, allNamespaces, hours, eventFilter, mergedItems, page, totalPages, total, rowsPerPage])

  useAIContext(aiSnapshot, [aiSnapshot])

  // an event's object goes with its apiVersion, so a Kind two groups serve opens the right group's object
  const handleResourceClick = useCallback((kind: string, name: string, ns: string, apiVersion?: string) => {
    openDetail(detailTarget(kind, name, ns, apiVersion))
  }, [openDetail])

  // Collect unique namespaces from the list
  const namespaceOptions = useMemo(() => {
    if (!namespaces) return []
    return (namespaces as any[]).map((n: any) => n.name).sort()
  }, [namespaces])

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      {/* Header */}
      <div className="shrink-0">
        <h1 className="text-xl font-semibold text-gray-900 dark:text-ink">
          {t('timeline.title', 'Change History Timeline')}
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          {t('timeline.subtitle', 'View K8s events and resource changes in chronological order.')}
        </p>
      </div>

      {/* Filter Bar */}
      <div className="shrink-0 flex flex-wrap items-center gap-3 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-3">
        {/* Namespace */}
        <CustomDropdown
          testId="timeline-namespace"
          className="w-44"
          options={[
            { value: '', label: t('timeline.allNamespaces', 'All namespaces') },
            ...namespaceOptions.map((ns: string) => ({ value: ns, label: ns })),
          ]}
          value={namespace}
          onChange={(v) => setSelectedNamespace(v)}
          placeholder={t('timeline.namespace', 'Namespace')}
        />

        {/* Time Range */}
        <div className="flex items-center gap-1 bg-gray-100 dark:bg-gray-700 rounded-md p-0.5">
          {TIME_RANGES.map((tr) => (
            <button
              key={tr.value}
              onClick={() => setHours(tr.value)}
              className={`px-2.5 py-1 text-xs font-medium rounded-sm transition-colors ${
                hours === tr.value
                  ? 'bg-primary-600 text-white shadow-xs'
                  : 'text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-ink'
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
              className={`px-2.5 py-1 text-xs font-medium rounded-sm transition-colors ${
                eventFilter === f
                  ? 'bg-primary-600 text-white shadow-xs'
                  : 'text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-ink'
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
          className="btn btn-primary flex items-center gap-2"
          title={t('timeline.refresh', 'Refresh')}
        >
          <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
          {t('timeline.refresh', 'Refresh')}
        </button>
      </div>

      {/* Summary Cards */}
      {timeline && (
        <div className="shrink-0 grid grid-cols-2 sm:grid-cols-4 gap-3">
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
            value={rolloutsCount(timeline) ?? '-'}
            color="blue"
          />
        </div>
      )}

      {/* Timeline — the list holds events and rollouts, so its count says both */}
      {timeline && mergedItems.length > 0 && (
        <p className="shrink-0 text-xs text-slate-400" data-testid="timeline-count">
          {t('timeline.listCount', {
            rows: mergedItems.length,
            events: mergedItems.filter((it) => it.type === 'event').length,
            rollouts: mergedItems.filter((it) => it.type === 'rollout').length,
            defaultValue: '{{rows}} items ({{events}} events · {{rollouts}} rollouts)',
          })}
        </p>
      )}
      {timeline && (timeline.summary.events_shown ?? 0) < (timeline.summary.events_matching ?? timeline.summary.total_events) && (
        <p className="shrink-0 text-xs text-slate-400" data-testid="timeline-events-capped">
          {eventFilter === 'all'
            ? t('timeline.eventsCapped', {
                shown: timeline.summary.events_shown,
                total: timeline.summary.events_matching ?? timeline.summary.total_events,
                defaultValue: 'The newest {{shown}} of the {{total}} events in this range are listed.',
              })
            : t('timeline.eventsCappedType', {
                shown: timeline.summary.events_shown,
                total: timeline.summary.events_matching,
                type: eventFilter,
                defaultValue: 'The newest {{shown}} of the {{total}} {{type}} events in this range are listed.',
              })}
        </p>
      )}
      {timeline?.summary.rollouts_error && (
        <p className="shrink-0 text-xs text-amber-400" data-testid="timeline-rollouts-error" title={timeline.summary.rollouts_error}>
          {t('timeline.rolloutsError', 'The rollouts could not be read, so none are listed.')}
        </p>
      )}
      <div ref={listRef} className="flex-1 min-h-0 flex flex-col bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg">
        <div ref={listBodyRef} className="flex-1 min-h-0 overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-20">
            <RefreshCw className="w-5 h-5 animate-spin text-gray-400" />
          </div>
        ) : isForbiddenError(error) ? (
          <div className="text-center py-16">
            <p className="text-sm text-gray-500 dark:text-gray-400" data-testid="timeline-forbidden">
              {t('common.forbiddenEmpty', { resource: forbiddenResourceFromUrl('/cluster/timeline'), defaultValue: 'You do not have permission to view {{resource}} in this cluster.' })}
            </p>
          </div>
        ) : visibleItems.length === 0 ? (
          <div className="text-center py-16">
            <Clock className="w-10 h-10 text-gray-300 dark:text-gray-600 mx-auto mb-3" />
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {t('timeline.noEvents', 'No events in this period')}
            </p>
            <p className="text-xs text-slate-400 mt-1">
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
                    <div ref={idx === 0 ? firstRowRef : undefined} data-testid="timeline-row">
                      {item.type === 'event' ? (
                        <EventRow
                          event={item.data}
                          onResourceClick={handleResourceClick}
                          showNamespace={allNamespaces}
                          t={t}
                        />
                      ) : (
                        <RolloutRow
                          rollout={item.data}
                          onResourceClick={handleResourceClick}
                          showNamespace={allNamespaces}
                          t={t}
                        />
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
        </div>
        {!isLoading && !isForbiddenError(error) && (
          <ListPager currentPage={page} totalPages={totalPages} total={total} rowsPerPage={rowsPerPage} onPageChange={setPage} testId="timeline-pager" />
        )}
      </div>
    </div>
  )
}

function SummaryCard({ label, value, color }: { label: string; value: number | string; color: 'blue' | 'green' | 'yellow' }) {
  const colors = {
    blue: 'bg-primary-50 dark:bg-primary-900/20 text-primary-700 dark:text-primary-300 border-primary-200 dark:border-primary-800',
    green: 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300 border-green-200 dark:border-green-800',
    yellow: 'bg-yellow-50 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-300 border-yellow-200 dark:border-yellow-800',
  }
  return (
    <div className={`border rounded-lg p-3 ${colors[color]}`}>
      <p className="text-xs opacity-80">{label}</p>
      <p className="text-2xl font-bold mt-0.5">{value}</p>
    </div>
  )
}

function EventRow({
  event,
  onResourceClick,
  showNamespace = false,
  t,
}: {
  event: TimelineEvent
  onResourceClick: (kind: string, name: string, ns: string, apiVersion?: string) => void
  showNamespace?: boolean
  t: any
}) {
  const isWarning = event.type === 'Warning'
  return (
    <div className="flex items-start gap-3 px-4 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors group">
      {/* Time */}
      <div className="w-[120px] shrink-0 text-right hidden md:block">
        <span
          className="text-xs text-slate-400 cursor-default"
          title={fmtAbsolute(event.timestamp)}
        >
          {fmtRelative(event.timestamp)}
        </span>
      </div>

      {/* Icon */}
      <div className="shrink-0 mt-0.5">
        {isWarning ? (
          <AlertTriangle className="w-4 h-4 text-yellow-500" />
        ) : (
          <CheckCircle2 className="w-4 h-4 text-green-500" />
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-gray-900 dark:text-ink">
            {event.reason}
          </span>
          {event.count > 1 && (
            <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 rounded-sm">
              {t('timeline.repeated', '{{count}} times').replace('{{count}}', String(event.count))}
            </span>
          )}
          <span className="text-xs text-slate-400 md:hidden">
            {fmtRelative(event.timestamp)}
          </span>
        </div>
        <p className="text-xs text-gray-600 dark:text-gray-400 mt-0.5 wrap-break-word">
          {event.message}
        </p>
        <div className="flex items-center gap-2 mt-1">
          <button
            onClick={() => onResourceClick(event.resource.kind, event.resource.name, event.resource.namespace, event.resource.api_version)}
            className="text-[11px] text-primary-600 dark:text-primary-400 hover:underline"
          >
            {showNamespace && event.resource.namespace ? `${event.resource.namespace} · ` : ''}{event.resource.kind}/{event.resource.name}
          </button>
          {event.source && (
            <span className="text-[11px] text-slate-400">
              {t('timeline.via', { defaultValue: 'via {{source}}', source: event.source })}
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
  showNamespace = false,
  t,
}: {
  rollout: RolloutRevision
  onResourceClick: (kind: string, name: string, ns: string) => void
  showNamespace?: boolean
  t: any
}) {
  return (
    <div className="flex items-start gap-3 px-4 py-2.5 bg-primary-50/50 dark:bg-primary-900/10 hover:bg-primary-50 dark:hover:bg-primary-900/20 transition-colors">
      {/* Time */}
      <div className="w-[120px] shrink-0 text-right hidden md:block">
        <span
          className="text-xs text-slate-400 cursor-default"
          title={fmtAbsolute(rollout.created_at)}
        >
          {fmtRelative(rollout.created_at)}
        </span>
      </div>

      {/* Icon */}
      <div className="shrink-0 mt-0.5">
        <ArrowUpCircle className="w-4 h-4 text-primary-500" />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-primary-800 dark:text-primary-300">
            {t('timeline.revision', 'Revision')} #{rollout.revision}
          </span>
          <span className="text-xs text-slate-400 md:hidden">
            {fmtRelative(rollout.created_at)}
          </span>
        </div>
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          <button
            onClick={() => onResourceClick(rollout.kind, rollout.name, rollout.namespace)}
            className="text-[11px] text-primary-600 dark:text-primary-400 hover:underline"
          >
            {showNamespace && rollout.namespace ? `${rollout.namespace} · ` : ''}{rollout.kind}/{rollout.name}
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
