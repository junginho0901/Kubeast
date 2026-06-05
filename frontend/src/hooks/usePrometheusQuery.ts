import { useQuery } from '@tanstack/react-query'
import { api, type PrometheusQueryResponse, type PrometheusRangeResponse, type ClusterFeatures } from '@/services/api'

/**
 * Fetch cluster-level feature flags (e.g. Prometheus enabled/disabled) once
 * at app boot and cache on the React Query client.
 *
 * Defaults to `{ prometheus: { enabled: true } }` if the request fails —
 * matches the backend's "no PROMETHEUS_ENABLED env var → assume enabled"
 * fallback so local-dev / older deployments keep auto-discovery.
 */
export function useClusterFeatures() {
  return useQuery<ClusterFeatures>({
    queryKey: ['cluster-features'],
    queryFn: () => api.getClusterFeatures(),
    staleTime: 5 * 60 * 1000, // 5 minutes — feature flags don't move
    retry: 1,
    // If the endpoint is missing (older backend) treat Prometheus as enabled
    // so behavior matches pre-toggle deployments.
    placeholderData: { prometheus: { enabled: true } },
  })
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
  const promEnabled = features.data?.prometheus?.enabled !== false
  return useQuery<PrometheusQueryResponse>({
    queryKey: ['prometheus', ...queryKey],
    queryFn: () => api.prometheusQuery(promql),
    refetchInterval: options?.refetchInterval ?? 30000,
    enabled: (options?.enabled ?? true) && promEnabled,
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
  // We query all metrics in a single batch by joining with `or`
  // But Prometheus `or` merges metrics, which doesn't work for different metric names.
  // Instead, we use individual queries with shared enabled/interval.
  const results = queries.map((q) =>
    usePrometheusQuery([...queryKey, q.name], q.promql, options),
  )

  const data: Record<string, PrometheusQueryResponse | undefined> = {}
  let isLoading = false
  let available = false

  for (let i = 0; i < queries.length; i++) {
    data[queries[i].name] = results[i].data
    if (results[i].isLoading) isLoading = true
    if (results[i].data?.available) available = true
  }

  return { data, isLoading, available }
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
  const promEnabled = features.data?.prometheus?.enabled !== false
  return useQuery<PrometheusRangeResponse>({
    queryKey: ['prometheus-range', ...queryKey, options?.step ?? 'step-default'],
    queryFn: () => api.prometheusQueryRange(promql, {
      start: options?.start,
      end: options?.end,
      step: options?.step,
    }),
    refetchInterval: options?.refetchInterval ?? 5 * 60 * 1000, // 5 min — range data is slow-moving
    enabled: (options?.enabled ?? true) && promEnabled,
    retry: 1,
    retryDelay: 2000,
    staleTime: 60 * 1000,
    placeholderData: promEnabled ? undefined : { available: false, results: [] },
  })
}
