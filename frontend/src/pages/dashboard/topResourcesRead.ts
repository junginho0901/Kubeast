// The Dashboard's top pods and nodes read (GET /cluster/metrics/top-resources), every 5 s. A part the cluster refused
// the caller (pod_metrics_refused, node_metrics_refused) is kept from that answer, named in the no-permission banner as a
// read beside a list, and not asked again (`skip`) until the page is opened again or another cluster is chosen, when
// the banner forgets it too. With both parts refused the read stops. A cluster without metrics-server is asked again
// after a minute, as Monitoring's tabs ask it (topResourcesPace).

import { isMetricsNotServedText, isMetricsUnavailableError, type TopResources } from '@/services/api'
import { recordForbidden } from '@/services/forbiddenStore'
import { retryUnlessRefused, unlessRefused } from '@/services/queryDefaults'
import { METRICS_NOT_SERVED_MS } from '../monitoring/metricsRefresh'

/** The parts the cluster refused since the page opened on cluster `ck`, each with the cluster's reason. */
export type TopRefusals = { ck: string; pods?: string; nodes?: string }

export const TOP_RESOURCES_POLL_MS = 5000

/** The parts a read leaves out: those already refused. */
export function skipOf(refused: TopRefusals): string | undefined {
  const parts = [refused.pods !== undefined ? 'pods' : '', refused.nodes !== undefined ? 'nodes' : ''].filter(Boolean)
  return parts.length ? parts.join(',') : undefined
}

/** The answer with each part left out filled from its refusal, and the refusals with those the answer adds. */
export function keepRefusals(answer: TopResources, refused: TopRefusals): { answer: TopResources; refused: TopRefusals } {
  const out: TopResources = { ...answer }
  if (refused.pods !== undefined) Object.assign(out, { top_pods: [], pod_metrics_error: refused.pods, pod_metrics_refused: true })
  if (refused.nodes !== undefined) Object.assign(out, { top_nodes: [], node_metrics_error: refused.nodes, node_metrics_refused: true })
  return {
    answer: out,
    refused: {
      ck: refused.ck,
      pods: answer.pod_metrics_refused ? answer.pod_metrics_error ?? '' : refused.pods,
      nodes: answer.node_metrics_refused ? answer.node_metrics_error ?? '' : refused.nodes,
    },
  }
}

/** How often the read goes again: never once both parts are refused. */
export function topResourcesPollMs(refused: TopRefusals | undefined, ck: string, stopped: boolean): number | false {
  if (stopped) return false
  if (refused?.ck === ck && refused.pods !== undefined && refused.nodes !== undefined) return false
  return TOP_RESOURCES_POLL_MS
}

/**
 * The read's pace: every 5 s, never again once both parts are refused, and after a minute while the cluster serves no
 * metrics.k8s.io (METRICS_NOT_SERVED_MS, as metricsReadPace), so a metrics-server installed since shows. That answer
 * is no session-long flag: Monitoring's tabs keep asking it for themselves. Neither it nor a refusal is tried again;
 * another failure once. The whole read refused (403) is not asked again either.
 */
export function topResourcesPace(refused: () => TopRefusals | undefined, ck: string) {
  return {
    refetchInterval: (query: { state: { error: unknown } }): number | false =>
      unlessRefused(query.state.error, isMetricsUnavailableError(query.state.error) ? METRICS_NOT_SERVED_MS : topResourcesPollMs(refused(), ck, false)),
    retry: (failureCount: number, error: unknown): boolean => !isMetricsUnavailableError(error) && retryUnlessRefused(1)(failureCount, error),
    retryDelay: 1000,
  }
}

const hasRows = (r: TopResources) => (r.top_pods?.length ?? 0) > 0 || (r.top_nodes?.length ?? 0) > 0

/**
 * One read for cluster `ck`, leaving out what `refusals` holds for it and adding what this answer refuses. No metrics
 * server is the metrics-unavailable error, as the other metrics reads raise it; a refusal is an answer; an empty answer
 * otherwise an error, so the cards keep the rows they had.
 */
export async function readTopResources(
  ck: string,
  read: (skip?: string) => Promise<TopResources>,
  refusals: { current: TopRefusals },
): Promise<TopResources> {
  const before: TopRefusals = refusals.current.ck === ck ? refusals.current : { ck }
  const { answer, refused } = keepRefusals(await read(skipOf(before)), before)
  refusals.current = refused
  if (refused.pods !== undefined && before.pods === undefined) recordForbidden('/cluster/metrics/pods', false)
  if (refused.nodes !== undefined && before.nodes === undefined) recordForbidden('/cluster/metrics/nodes', false)
  if (hasRows(answer)) return answer
  // The k8s-service answers 200 with empty lists and the metrics API error when the cluster has no metrics-server
  // ("could not find the requested resource").
  const apiErr = `${answer.pod_metrics_error || ''} ${answer.node_metrics_error || ''}`
  if (isMetricsNotServedText(apiErr)) {
    const unavailable: any = new Error('metrics server not available')
    unavailable.response = { status: 503, data: { code: 'metrics_unavailable' } }
    throw unavailable
  }
  if (refused.pods !== undefined || refused.nodes !== undefined) return answer
  throw new Error('No valid metrics data available')
}
