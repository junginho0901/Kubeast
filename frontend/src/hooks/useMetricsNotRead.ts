import { useAIContext } from './useAIContext'
import { METRICS_NOT_READ, type NotRead } from '@/utils/aiContext/metricsNotRead'

/** Tells the floating chat the numbers a screen could not show (utils/aiContext/metricsNotRead), while it says so. */
export function useMetricsNotReadForChat(notRead: NotRead | null): void {
  useAIContext(notRead ? { source: METRICS_NOT_READ, summary: notRead.summary, data: notRead.data } : null, [notRead?.summary, JSON.stringify(notRead?.data ?? null)])
}
