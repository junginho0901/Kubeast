// Public entry point for the API surface. The original
// services/api.ts has been split into per-domain sub-files; this
// index re-assembles the historical `api` object so callers like
// `import { api } from '@/services/api'` see no behavior change.
//
// Spread order is alphabetical except for nested namespaces (helm),
// which are kept as objects so call sites can still write
// `api.helm.listReleases(...)`.

import { adminApi } from './admin'
import { aiApi } from './ai'
import { authApi } from './auth'
import { clusterApi } from './cluster'
import { clustersApi } from './clusters'
import { configurationApi } from './configuration'
import { customResourcesApi } from './custom_resources'
import { gatewayApi } from './gateway'
import { gpuApi } from './gpu'
import { helmApi } from './helm'
import { metricsApi } from './metrics'
import { modelConfigApi } from './model_config'
import { networkApi } from './network'
import { podsApi } from './pods'
import { securityApi } from './security'
import { sessionsApi } from './sessions'
import { storageApi } from './storage'
import { topologyApi } from './topology'
import { workloadsApi } from './workloads'

export const api = {
  ...authApi,
  ...adminApi,
  ...clusterApi,
  ...workloadsApi,
  ...podsApi,
  ...networkApi,
  ...gatewayApi,
  ...storageApi,
  ...securityApi,
  ...configurationApi,
  ...customResourcesApi,
  ...topologyApi,
  ...metricsApi,
  ...gpuApi,
  ...aiApi,
  ...sessionsApi,
  ...modelConfigApi,
  helm: helmApi,
  clusters: clustersApi,
}

// Multi-cluster registry API (also usable directly as `clustersApi`).
export { clustersApi } from './clusters'
export type {
  ClusterMeta,
  ClusterMode,
  ConnectionResult,
  DeploymentMode,
  RegisterClusterInput,
} from './clusters'

// Re-export shared types — call sites do
// `import { PodInfo } from '@/services/api'`.
export * from './types'

// Re-export Helm-specific types that lived in api.ts originally.
export type {
  HelmDiffResponse,
  HelmHistoryEntry,
  HelmReleaseDetail,
  HelmReleaseResource,
  HelmReleaseSummary,
  HelmRevisionSectionResponse,
  HelmRollbackResponse,
  HelmSection,
  HelmSectionResponse,
  HelmTestHookResult,
  HelmTestResponse,
  HelmUninstallResponse,
  HelmUpgradeResponse,
} from './helm'

// Re-export client helpers used by feature pages
// (Dashboard / Monitoring etc.).
export {
  disableMetrics,
  isMetricsDisabled,
  isMetricsUnavailableError,
} from './client'
