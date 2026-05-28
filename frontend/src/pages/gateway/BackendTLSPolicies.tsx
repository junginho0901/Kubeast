import { useTranslation } from 'react-i18next'
import { api, type BackendTLSPolicyInfo } from '@/services/api'
import BackendPoliciesPage from './backend-policies/BackendPoliciesPage'
import type { BackendPolicyConfig } from './backend-policies/useBackendPoliciesData'

const config: BackendPolicyConfig<BackendTLSPolicyInfo> = {
  kind: 'BackendTLSPolicy',
  queryKeyPrefix: ['gateway', 'backendtlspolicies'] as const,
  watchPath: (ns) => ns === 'all' ? '/api/v1/backendtlspolicies' : `/api/v1/namespaces/${ns}/backendtlspolicies`,
  describeQueryKey: 'backendtlspolicy-describe',
  permissionCreate: 'resource.backendtlspolicy.create',
  list: (ns, force) => api.getBackendTLSPolicies(ns, force),
  listAll: (force) => api.getAllBackendTLSPolicies(force),
  aiSummaryLabel: 'BackendTLSPolicy',
}

const yamlBody = `spec:
  targetRefs:
    - group: ""
      kind: Service
      name: my-service
  validation:
    hostname: my-service.example.com
    wellKnownCACertificates: System
`

export default function BackendTLSPolicies() {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })

  return (
    <BackendPoliciesPage<BackendTLSPolicyInfo>
      config={config}
      apiVersion="gateway.networking.k8s.io/v1alpha3"
      yamlBodyTemplate={yamlBody}
      i18nPrefix="backendTLSPoliciesPage"
      strings={{
        title: tr('backendTLSPoliciesPage.title', 'Backend TLS Policies'),
        subtitle: tr('backendTLSPoliciesPage.subtitle', 'Inspect and manage Gateway API BackendTLSPolicy resources across namespaces.'),
        createButton: tr('backendTLSPoliciesPage.create', 'Create BackendTLSPolicy'),
        refreshTitle: tr('backendTLSPoliciesPage.refreshTitle', 'Force refresh'),
        searchPlaceholder: tr('backendTLSPoliciesPage.searchPlaceholder', 'Search BackendTLSPolicies by name...'),
        allNamespaces: tr('backendTLSPoliciesPage.allNamespaces', 'All namespaces'),
        statsTotal: tr('backendTLSPoliciesPage.stats.total', 'Total'),
        statsAccepted: tr('backendTLSPoliciesPage.stats.accepted', 'Accepted'),
        statsWithTargets: tr('backendTLSPoliciesPage.stats.withTargets', 'With Targets'),
        matchCount: (count: number) => tr('backendTLSPoliciesPage.matchCount', '{{count}} BackendTLSPolic{{suffix}} match.', {
          count,
          suffix: count === 1 ? 'y' : 'ies',
        }),
        tableNamespace: tr('backendTLSPoliciesPage.table.namespace', 'Namespace'),
        tableName: tr('backendTLSPoliciesPage.table.name', 'Name'),
        tableTargetRef: tr('backendTLSPoliciesPage.table.targetRef', 'Target Ref'),
        tableStatus: tr('backendTLSPoliciesPage.table.status', 'Status'),
        tableAge: tr('backendTLSPoliciesPage.table.age', 'Age'),
        noResults: tr('backendTLSPoliciesPage.noResults', 'No BackendTLSPolicies found.'),
        createDialogTitle: tr('backendTLSPoliciesPage.createTitle', 'Create BackendTLSPolicy from YAML'),
        matchSuffixSingular: 'y',
        matchSuffixPlural: 'ies',
      }}
    />
  )
}
