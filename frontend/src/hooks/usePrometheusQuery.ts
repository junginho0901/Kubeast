import { useQueries, useQuery } from '@tanstack/react-query'
import { api, type PrometheusQueryResponse, type PrometheusRangeResponse, type ClusterFeatures, type ServiceBackendUsage } from '@/services/api'
import { clustersApi } from '@/services/api/clusters'
import { useCluster } from '@/contexts/ClusterContext'
import { aiState, type AIState } from '@/utils/features'

/**
 * Fetch cluster-level feature flags (e.g. Prometheus enabled/disabled) once
 * at app boot and cache on the React Query client.
 *
 * Defaults to `{ prometheus: { enabled: true } }` if the request fails —
 * matches the backend's "no PROMETHEUS_ENABLED env var → assume enabled"
 * fallback so local-dev / older deployments keep auto-discovery.
 */
export function useClusterFeatures() {
  // Asked once the picker has settled on one of this user's clusters: a request without ?cluster= is
  // answered for the server's default cluster, which the user may not be allowed on (403, "No permission").
  const { currentCluster } = useCluster()
  const { data: clusters, isSuccess } = useQuery({
    queryKey: ['clusters-accessible'],
    queryFn: () => clustersApi.listClusters(true),
    staleTime: 30_000,
  })
  const settled = isSuccess && (clusters.length === 0 || clusters.some((c) => c.id === currentCluster))
  return useQuery<ClusterFeatures>({
    queryKey: ['cluster-features', currentCluster],
    queryFn: () => api.getClusterFeatures(),
    enabled: settled,
    staleTime: 5 * 60 * 1000, // 5 minutes — feature flags don't move
    retry: 1,
    // If the endpoint is missing (older backend) treat Prometheus as enabled
    // so behavior matches pre-toggle deployments.
    placeholderData: { prometheus: { enabled: true } },
  })
}

// ai.enabled once the features have answered (aiState); the cluster list is the read the features wait for.
export function useAIState(): AIState {
  const features = useClusterFeatures()
  const clusters = useQuery({ queryKey: ['clusters-accessible'], queryFn: () => clustersApi.listClusters(true), staleTime: 30_000 })
  return aiState(features.data, features.isPlaceholderData, clusters.isError)
}

// The hooks ask only while the cluster's toggle is on and the caller's grant covers the whole cluster: a grant
// limited to namespaces is refused the cluster's Prometheus (features.prometheus.namespaceLimited).
export function prometheusReadable(features: ClusterFeatures | undefined): boolean {
  return features?.prometheus?.enabled !== false && features?.prometheus?.namespaceLimited !== true
}

// A read's error when the cluster's Prometheus is set but did not answer — the server's 5xx (502 with its reason) or no
// answer at all; null for anything else (a refusal is not the store's silence).
export function prometheusNotAnswering(err: unknown): unknown {
  if (!err) return null
  const status = (err as { response?: { status?: number } }).response?.status
  return status === undefined || status >= 500 ? err : null
}

/**
 * Generic hook for querying Prometheus via the backend proxy.
 * Returns { available, results } or undefined while loading.
 * If Prometheus is not available, `available` will be false and `results` will be empty.
 *
 * Honors the cluster-level toggle: when `features.prometheus.enabled=false`
 * the query is never issued and we return a stub `{ available: false, results: [] }`.
 *
 * @param queryKey - unique cache key suffix (e.g. ['node-cpu', nodeName])
 * @param promql - PromQL query string
 * @param options - refetchInterval, enabled, etc.
 */
export function usePrometheusQuery(
  queryKey: string[],
  promql: string,
  options?: { enabled?: boolean; refetchInterval?: number },
) {
  const features = useClusterFeatures()
  const promEnabled = prometheusReadable(features.data)
  // the features' placeholder says "on" while they load: ask once they have come (or failed)
  const featuresIn = features.isFetched
  // Scope to the selected cluster so metrics never bleed across a switch.
  const { currentCluster } = useCluster()
  return useQuery<PrometheusQueryResponse>({
    queryKey: ['prometheus', currentCluster || 'default', ...queryKey],
    queryFn: () => api.prometheusQuery(promql),
    refetchInterval: options?.refetchInterval ?? 30000,
    enabled: (options?.enabled ?? true) && featuresIn && promEnabled,
    retry: 1,
    retryDelay: 2000,
    staleTime: 10000,
    // Stub when the toggle is off so consumers see `available: false`
    // without ever firing a request.
    placeholderData: promEnabled ? undefined : { available: false, results: [] },
  })
}

/**
 * Query multiple PromQL in parallel and return results keyed by name.
 */
export function usePrometheusQueries(
  queryKey: string[],
  queries: { name: string; promql: string }[],
  options?: { enabled?: boolean; refetchInterval?: number },
) {
  // Prometheus `or` merges series, which doesn't work across metric names, so
  // each PromQL is its own query. useQueries keeps the hook count constant
  // (a hook per array element would break the Rules of Hooks).
  const features = useClusterFeatures()
  const promEnabled = prometheusReadable(features.data)
  // the features' placeholder says "on" while they load: ask once they have come (or failed)
  const featuresIn = features.isFetched
  const { currentCluster } = useCluster()
  const results = useQueries({
    queries: queries.map((q) => ({
      queryKey: ['prometheus', currentCluster || 'default', ...queryKey, q.name],
      queryFn: () => api.prometheusQuery(q.promql),
      refetchInterval: options?.refetchInterval ?? 30000,
      enabled: (options?.enabled ?? true) && featuresIn && promEnabled,
      retry: 1,
      retryDelay: 2000,
      staleTime: 10000,
      placeholderData: promEnabled ? undefined : ({ available: false, results: [] } as PrometheusQueryResponse),
    })),
  })

  const data: Record<string, PrometheusQueryResponse | undefined> = {}
  let isLoading = false
  let available = false
  let failure: unknown = null

  for (let i = 0; i < queries.length; i++) {
    data[queries[i].name] = results[i].data
    if (results[i].isLoading) isLoading = true
    if (results[i].data?.available) available = true
    if (failure === null) failure = prometheusNotAnswering(results[i].error)
  }

  // A Prometheus that is set but did not answer is an error (the server's 502 and its reason); one the cluster
  // does not have is `available: false` with no error, which the sections leave out as before.
  return { data, isLoading, available, failure: available ? null : failure }
}

/**
 * Range query hook — backs sparkline / 24h-trend sections.
 *
 * Same gating rules as `usePrometheusQuery`: short-circuits when the cluster
 * toggle is off. Window/step defaults to backend's defaults (24h, 5m step).
 */
export function usePrometheusRangeQuery(
  queryKey: string[],
  promql: string,
  options?: {
    enabled?: boolean
    refetchInterval?: number
    start?: number
    end?: number
    step?: number
  },
) {
  const features = useClusterFeatures()
  const promEnabled = prometheusReadable(features.data)
  // the features' placeholder says "on" while they load: ask once they have come (or failed)
  const featuresIn = features.isFetched
  const { currentCluster } = useCluster()
  return useQuery<PrometheusRangeResponse>({
    queryKey: ['prometheus-range', currentCluster || 'default', ...queryKey, options?.step ?? 'step-default'],
    queryFn: () => api.prometheusQueryRange(promql, {
      start: options?.start,
      end: options?.end,
      step: options?.step,
    }),
    refetchInterval: options?.refetchInterval ?? 5 * 60 * 1000, // 5 min — range data is slow-moving
    enabled: (options?.enabled ?? true) && featuresIn && promEnabled,
    retry: 1,
    retryDelay: 2000,
    staleTime: 60 * 1000,
    placeholderData: promEnabled ? undefined : { available: false, results: [] },
  })
}

/**
 * The Service drawer's backend pod sums as the server adds them up (GET …/services/{name}/backend-usage), for a Service
 * whose pods one query from the screen cannot name. Same gating as the other Prometheus reads; `available` and `failure`
 * as usePrometheusQueries gives them, for `PrometheusSection`.
 */
export function useServiceBackendUsage(namespace: string, name: string, options?: { enabled?: boolean }) {
  const features = useClusterFeatures()
  const promEnabled = prometheusReadable(features.data)
  // the features' placeholder says "on" while they load: ask once they have come (or failed)
  const featuresIn = features.isFetched
  const { currentCluster } = useCluster()
  const query = useQuery<ServiceBackendUsage>({
    queryKey: ['prometheus', currentCluster || 'default', 'service-backend-usage', namespace, name],
    queryFn: () => api.serviceBackendUsage(namespace, name),
    refetchInterval: 30000,
    enabled: (options?.enabled ?? true) && featuresIn && promEnabled,
    retry: 1,
    retryDelay: 2000,
    staleTime: 10000,
  })
  const available = !!query.data?.available
  return { data: query.data, available, failure: available ? null : prometheusNotAnswering(query.error) }
}
