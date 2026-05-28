import { useTranslation } from 'react-i18next'
import { api, type BackendTrafficPolicyInfo } from '@/services/api'
import BackendPoliciesPage from './backend-policies/BackendPoliciesPage'
import type { BackendPolicyConfig } from './backend-policies/useBackendPoliciesData'

const config: BackendPolicyConfig<BackendTrafficPolicyInfo> = {
  kind: 'BackendTrafficPolicy',
  queryKeyPrefix: ['gateway', 'backendtrafficpolicies'] as const,
  watchPath: (ns) => ns === 'all' ? '/api/v1/backendtrafficpolicies' : `/api/v1/namespaces/${ns}/backendtrafficpolicies`,
  describeQueryKey: 'backendtrafficpolicy-describe',
  permissionCreate: 'resource.backendtrafficpolicy.create',
  list: (ns, force) => api.getBackendTrafficPolicies(ns, force),
  listAll: (force) => api.getAllBackendTrafficPolicies(force),
  aiSummaryLabel: 'BackendTrafficPolicy',
}

const yamlBody = `spec:
  targetRefs:
    - group: ""
      kind: Service
      name: my-service
`

export default function BackendTrafficPolicies() {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })

  return (
    <BackendPoliciesPage<BackendTrafficPolicyInfo>
      config={config}
      apiVersion="gateway.networking.k8s.io/v1alpha2"
      yamlBodyTemplate={yamlBody}
      i18nPrefix="backendTrafficPoliciesPage"
      strings={{
        title: tr('backendTrafficPoliciesPage.title', 'Backend Traffic Policies'),
        subtitle: tr('backendTrafficPoliciesPage.subtitle', 'Inspect and manage Gateway API BackendTrafficPolicy resources across namespaces.'),
        createButton: tr('backendTrafficPoliciesPage.create', 'Create BackendTrafficPolicy'),
        refreshTitle: tr('backendTrafficPoliciesPage.refreshTitle', 'Force refresh'),
        searchPlaceholder: tr('backendTrafficPoliciesPage.searchPlaceholder', 'Search BackendTrafficPolicies by name...'),
        allNamespaces: tr('backendTrafficPoliciesPage.allNamespaces', 'All namespaces'),
        statsTotal: tr('backendTrafficPoliciesPage.stats.total', 'Total'),
        statsAccepted: tr('backendTrafficPoliciesPage.stats.accepted', 'Accepted'),
        statsWithTargets: tr('backendTrafficPoliciesPage.stats.withTargets', 'With Targets'),
        matchCount: (count: number) => tr('backendTrafficPoliciesPage.matchCount', '{{count}} BackendTrafficPolic{{suffix}} match.', {
          count,
          suffix: count === 1 ? 'y' : 'ies',
        }),
        tableNamespace: tr('backendTrafficPoliciesPage.table.namespace', 'Namespace'),
        tableName: tr('backendTrafficPoliciesPage.table.name', 'Name'),
        tableTargetRef: tr('backendTrafficPoliciesPage.table.targetRef', 'Target Ref'),
        tableStatus: tr('backendTrafficPoliciesPage.table.status', 'Status'),
        tableAge: tr('backendTrafficPoliciesPage.table.age', 'Age'),
        noResults: tr('backendTrafficPoliciesPage.noResults', 'No BackendTrafficPolicies found.'),
        createDialogTitle: tr('backendTrafficPoliciesPage.createTitle', 'Create BackendTrafficPolicy from YAML'),
        matchSuffixSingular: 'y',
        matchSuffixPlural: 'ies',
      }}
    />
  )
}
