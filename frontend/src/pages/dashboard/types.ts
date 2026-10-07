// Shared types for the Dashboard page sub-components.
//
// Kept in one file rather than colocated because the issue derivation
// logic spans pods, nodes, deployments, PVCs, and metrics — splitting
// the union into per-resource files would just spread the same export
// list across five files.

export type ResourceType =
  | 'namespaces'
  | 'pods'
  | 'services'
  | 'deployments'
  | 'pvcs'
  | 'nodes'

export type IssueSeverity = 'critical' | 'warning' | 'info'

// The Kubernetes kind the API reports ("Pod", "Deployment",
// "PersistentVolumeClaim", …) or "Collector" for a list that failed.
export type IssueKind = string

export interface IssueItem {
  id: string
  kind: IssueKind
  severity: IssueSeverity
  title: string
  subtitle?: string
  namespace?: string
  name?: string
  lastSeen?: string
  count?: number
}

export interface OptimizationUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

export interface OptimizationMeta {
  finish_reason?: string | null
  max_tokens?: number | null
}
