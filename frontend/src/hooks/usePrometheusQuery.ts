import { useQuery } from '@tanstack/react-query'
import { api, type PrometheusQueryResponse } from '@/services/api'

/**
 * Generic hook for querying Prometheus via the backend proxy.
 * Returns { available, results } or undefined while loading.
 * If Prometheus is not available, `available` will be false and `results` will be empty.
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
  return useQuery<PrometheusQueryResponse>({
    queryKey: ['prometheus', ...queryKey],
    queryFn: () => api.prometheusQuery(promql),
    refetchInterval: options?.refetchInterval ?? 30000,
    enabled: options?.enabled ?? true,
    retry: 1,
    retryDelay: 2000,
    staleTime: 10000,
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
