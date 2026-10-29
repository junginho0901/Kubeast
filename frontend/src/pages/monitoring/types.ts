// Wire types for the metrics-server backed Monitoring page.
//
// Kept in a sibling file (rather than colocated with each tab) because
// both tabs share the same API client and AI snapshot logic that
// references them.

export interface NodeMetric {
  name: string
  cpu: string
  cpu_percent: string
  memory: string
  memory_percent: string
  timestamp?: string
}

export interface PodMetric {
  name: string
  namespace: string
  cpu: string
  memory: string
  timestamp?: string
  // asked with with_limits: the pod's limits, null without one
  cpu_limit_millicores?: number | null
  memory_limit_bytes?: number | null
}
