import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import en from '../../i18n/locales/en.json'
import { ResourceDetailContext, type ResourceDetailTarget } from '../ResourceDetailContext'
import ResourceDetailDrawer from '../ResourceDetailDrawer'
import { ConfirmContext } from '@/services/confirm'
import { DRAWER_GROUPS, deleteTarget, kindResource } from './crDetail'
import NodeInfo from './NodeInfo'
import NamespaceInfo from './NamespaceInfo'
import CustomResourceInstanceInfo from './CustomResourceInstanceInfo'

// The drawer's Delete button asks the cluster about the object, as the create buttons do, and a drawer the caller may
// not read says so in one notice whichever view read it: the Node, Namespace and custom resource views as the rest.

const granted = new Set<string>()
vi.mock('@/hooks/usePermission', () => ({ usePermission: () => ({ has: (p: string) => granted.has(p) }) }))
const layers: { source?: string; data?: Record<string, unknown> }[] = []
vi.mock('@/hooks/useAIContext', () => ({ useAIContext: (input: { source?: string; data?: Record<string, unknown> } | null) => { if (input) layers.push(input) } }))
// the kinds' own views are not under test here: the header and the notice are
vi.mock('./ClusterRoleInfo', () => ({ default: () => null }))
vi.mock('./AdmissionPolicyInfo', () => ({ default: () => null }))
vi.mock('./PolicyViolations', () => ({ default: () => null }))

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en', fallbackLng: 'en', ns: ['translation', 'detail'], defaultNS: 'translation',
    resources: { en: { translation: en, detail: {} } }, interpolation: { escapeValue: false },
  })
})
beforeEach(() => {
  granted.clear()
  layers.length = 0
})

type Seed = [unknown[], unknown]
// a refused or failed read is an error with its HTTP status, as axios gives it
const failed = (status: number) => ({ failed: status })
function client(seed: Seed[]): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } })
  for (const [key, value] of seed) {
    if (value && typeof value === 'object' && 'failed' in value) {
      const status = (value as { failed: number }).failed
      const q = qc.getQueryCache().build(qc, { queryKey: key })
      q.setState({ ...q.state, status: 'error', error: Object.assign(new Error(`HTTP ${status}`), { response: { status } }), errorUpdatedAt: Date.now(), errorUpdateCount: 1 })
    } else qc.setQueryData(key, value)
  }
  return qc
}
const render = (el: ReactElement, seed: Seed[] = []) =>
  renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(QueryClientProvider, { client: client(seed) }, el)))
const drawer = (target: ResourceDetailTarget, seed: Seed[] = []) =>
  render(createElement(ConfirmContext.Provider, { value: async () => true },
    createElement(ResourceDetailContext.Provider, { value: { target, open: () => {}, close: () => {}, goBack: () => {}, canGoBack: false } },
      createElement(ResourceDetailDrawer))), seed)
const deleteButtons = (html: string, kind: string) => html.split(`</svg>${en.common.deleteKind.replace('{{kind}}', kind)}</button>`).length - 1
const NOTICE = 'data-testid="detail-unreadable"'

// `kubectl api-resources` of the dev cluster (raw/20261105/perm-fix-b/api-resources.txt) and, for the kinds it does
// not serve, the Gateway API v1.4 and VPA 1.7 CRDs' plurals
const API_RESOURCES: Record<string, string> = {
  Pod: 'pods', Node: 'nodes', Namespace: 'namespaces', Service: 'services', ConfigMap: 'configmaps', Secret: 'secrets',
  ServiceAccount: 'serviceaccounts', Endpoints: 'endpoints', PersistentVolume: 'persistentvolumes',
  PersistentVolumeClaim: 'persistentvolumeclaims', ResourceQuota: 'resourcequotas', LimitRange: 'limitranges',
  Deployment: 'deployments.apps', StatefulSet: 'statefulsets.apps', DaemonSet: 'daemonsets.apps', ReplicaSet: 'replicasets.apps',
  Job: 'jobs.batch', CronJob: 'cronjobs.batch', HorizontalPodAutoscaler: 'horizontalpodautoscalers.autoscaling',
  VerticalPodAutoscaler: 'verticalpodautoscalers.autoscaling.k8s.io', PodDisruptionBudget: 'poddisruptionbudgets.policy',
  Ingress: 'ingresses.networking.k8s.io', IngressClass: 'ingressclasses.networking.k8s.io',
  NetworkPolicy: 'networkpolicies.networking.k8s.io', EndpointSlice: 'endpointslices.discovery.k8s.io',
  StorageClass: 'storageclasses.storage.k8s.io', VolumeAttachment: 'volumeattachments.storage.k8s.io',
  Role: 'roles.rbac.authorization.k8s.io', RoleBinding: 'rolebindings.rbac.authorization.k8s.io',
  ClusterRole: 'clusterroles.rbac.authorization.k8s.io', ClusterRoleBinding: 'clusterrolebindings.rbac.authorization.k8s.io',
  PriorityClass: 'priorityclasses.scheduling.k8s.io', RuntimeClass: 'runtimeclasses.node.k8s.io', Lease: 'leases.coordination.k8s.io',
  MutatingWebhookConfiguration: 'mutatingwebhookconfigurations.admissionregistration.k8s.io',
  ValidatingWebhookConfiguration: 'validatingwebhookconfigurations.admissionregistration.k8s.io',
  ValidatingAdmissionPolicy: 'validatingadmissionpolicies.admissionregistration.k8s.io',
  MutatingAdmissionPolicy: 'mutatingadmissionpolicies.admissionregistration.k8s.io',
  CustomResourceDefinition: 'customresourcedefinitions.apiextensions.k8s.io',
  Gateway: 'gateways.gateway.networking.k8s.io', GatewayClass: 'gatewayclasses.gateway.networking.k8s.io',
  HTTPRoute: 'httproutes.gateway.networking.k8s.io', GRPCRoute: 'grpcroutes.gateway.networking.k8s.io',
  ReferenceGrant: 'referencegrants.gateway.networking.k8s.io', BackendTLSPolicy: 'backendtlspolicies.gateway.networking.k8s.io',
  DeviceClass: 'deviceclasses.resource.k8s.io', ResourceClaim: 'resourceclaims.resource.k8s.io',
  ResourceClaimTemplate: 'resourceclaimtemplates.resource.k8s.io', ResourceSlice: 'resourceslices.resource.k8s.io',
}

describe('what a drawer\'s Delete asks the cluster about', () => {
  it('every kind with a drawer of its own: the resource and group the API server serves it as', () => {
    const asked = Object.fromEntries(Object.entries(DRAWER_GROUPS).map(([kind, group]) => [kind, group ? `${kindResource(kind)}.${group}` : kindResource(kind)]))
    expect(asked).toEqual(API_RESOURCES)
  })

  it('the object\'s namespace and name; a Namespace in its own name; cluster-scoped kinds in none', () => {
    expect(deleteTarget('ConfigMap', 'ns-a', 'cm')).toEqual({ group: '', resource: 'configmaps', namespace: 'ns-a', name: 'cm' })
    expect(deleteTarget('Namespace', undefined, 'ns-a')).toEqual({ group: '', resource: 'namespaces', namespace: 'ns-a', name: 'ns-a' })
    expect(deleteTarget('ClusterRole', undefined, 'cr')).toEqual({ group: 'rbac.authorization.k8s.io', resource: 'clusterroles', namespace: '', name: 'cr' })
  })

  it('a custom resource: the group and plural it carries; nothing to ask without them or for a kind with no drawer', () => {
    expect(deleteTarget('CustomResourceInstance', 'ns-a', 'w', { kind: 'Widget', group: 'qa.example.com', version: 'v1', crd_name: 'widgets.qa.example.com' }))
      .toEqual({ group: 'qa.example.com', resource: 'widgets', namespace: 'ns-a', name: 'w' })
    expect(deleteTarget('CustomResourceInstance', 'ns-a', 'w', { kind: 'Widget' })).toBeUndefined()
    expect(deleteTarget('Widget', 'ns-a', 'w')).toBeUndefined()
  })
})

describe('the drawer\'s Delete button', () => {
  const WRITE = ['resource.clusterrole.delete', 'resource.namespace.delete', 'resource.customresource.delete', 'resource.validatingadmissionpolicy.delete']
  const RBAC = 'rbac.authorization.k8s.io'
  const role = { kind: 'ClusterRole', name: 'cr', rawJson: { metadata: { name: 'cr', annotations: {} } } }

  it('shown when the app permission holds and the cluster lets the user delete that object', () => {
    WRITE.forEach((p) => granted.add(p))
    expect(deleteButtons(drawer(role, [[['can-i', '', 'delete', RBAC, 'clusterroles', '', 'cr'], true]]), 'ClusterRole')).toBe(1)
  })

  it('hidden when the cluster says no (a Write grant\'s edit cannot delete cluster-scoped objects)', () => {
    WRITE.forEach((p) => granted.add(p))
    expect(deleteButtons(drawer(role, [[['can-i', '', 'delete', RBAC, 'clusterroles', '', 'cr'], false]]), 'ClusterRole')).toBe(0)
  })

  it('hidden while the cluster is asked; the app permission decides when it cannot be asked', () => {
    WRITE.forEach((p) => granted.add(p))
    expect(deleteButtons(drawer(role), 'ClusterRole'), 'no answer yet').toBe(0)
    expect(deleteButtons(drawer(role, [[['can-i', '', 'delete', RBAC, 'clusterroles', '', 'cr'], failed(500)]]), 'ClusterRole'), 'cannot ask').toBe(1)
  })

  it('a Namespace is asked about in its own name, a custom resource with its group and plural', () => {
    WRITE.forEach((p) => granted.add(p))
    const ns = { kind: 'Namespace', name: 'ns-a' }
    expect(deleteButtons(drawer(ns, [[['can-i', '', 'delete', '', 'namespaces', 'ns-a', 'ns-a'], true]]), 'Namespace')).toBe(1)
    expect(deleteButtons(drawer(ns, [[['can-i', '', 'delete', '', 'namespaces', 'ns-a', 'ns-a'], false]]), 'Namespace')).toBe(0)
    const cr = { kind: 'CustomResourceInstance', name: 'w', namespace: 'ns-a', rawJson: { kind: 'Widget', group: 'qa.example.com', version: 'v1', crd_name: 'widgets.qa.example.com' } }
    const crSeed = (answer: boolean): Seed[] => [[['can-i', '', 'delete', 'qa.example.com', 'widgets', 'ns-a', 'w'], answer], [['cr-instance-describe', 'qa.example.com', 'v1', 'widgets', 'ns-a', 'w'], { kind: 'Widget' }]]
    expect(deleteButtons(drawer(cr, crSeed(true)), 'Widget')).toBe(1)
    expect(deleteButtons(drawer(cr, crSeed(false)), 'Widget')).toBe(0)
  })

  it('hidden without the app permission, and for the admission policies Kubeast has no delete for', () => {
    expect(deleteButtons(drawer(role, [[['can-i', '', 'delete', RBAC, 'clusterroles', '', 'cr'], true]]), 'ClusterRole')).toBe(0)
    WRITE.forEach((p) => granted.add(p))
    const vap = { kind: 'ValidatingAdmissionPolicy', name: 'p', rawJson: { metadata: { name: 'p' } } }
    expect(deleteButtons(drawer(vap, [[['can-i', '', 'delete', 'admissionregistration.k8s.io', 'validatingadmissionpolicies', '', 'p'], true]]), 'ValidatingAdmissionPolicy')).toBe(0)
  })

  it('the row under the title is as tall as the button with or without it, so nothing moves when it appears', () => {
    WRITE.forEach((p) => granted.add(p))
    const rowOf = (html: string) => /<div class="([^"]*)"><button[^>]*>(?:(?!<\/div>).)*?Info<\/button>/.exec(html)?.[1] ?? 'no tab row'
    expect(rowOf(drawer(role))).toContain('min-h-7.5')
    expect(rowOf(drawer(role, [[['can-i', '', 'delete', RBAC, 'clusterroles', '', 'cr'], true]]))).toContain('min-h-7.5')
  })

  it('an object opened by link: no Delete until its read has answered, so a gone or refused one never flashes it', () => {
    WRITE.forEach((p) => granted.add(p))
    const yes: Seed = [['can-i', '', 'delete', RBAC, 'clusterroles', '', 'cr'], true]
    expect(deleteButtons(drawer({ kind: 'ClusterRole', name: 'cr' }, [yes]), 'ClusterRole'), 'read in flight').toBe(0)
    expect(deleteButtons(drawer({ kind: 'ClusterRole', name: 'cr' }, [yes, [['resource-json', 'ClusterRole', undefined, 'cr'], { metadata: { name: 'cr' } }]]), 'ClusterRole'), 'read').toBe(1)
  })

  it('an object opened by link that the caller may not read: the notice, no Delete (as before)', () => {
    WRITE.forEach((p) => granted.add(p))
    const html = drawer({ kind: 'ClusterRole', name: 'cr' }, [[['resource-json', 'ClusterRole', undefined, 'cr'], failed(403)], [['can-i', '', 'delete', RBAC, 'clusterroles', '', 'cr'], true]])
    expect(html).toContain(NOTICE)
    expect(html).toContain(en.common.objectForbidden)
    expect(deleteButtons(html, 'ClusterRole')).toBe(0)
  })
})

describe('a drawer the caller may not read says so, whichever view read it', () => {
  const notice = (html: string) => (html.includes(NOTICE) ? (html.includes(en.common.objectForbidden) ? 'forbidden' : 'another notice') : 'no notice')
  const crRaw = { kind: 'GuardCheck', group: 'g.kubeast.io', version: 'v1', crd_name: 'guardchecks.g.kubeast.io' }
  const crKey = ['cr-instance-describe', 'g.kubeast.io', 'v1', 'guardchecks', 'ns-b', 'gc']
  const views: [string, () => ReactElement, unknown[], string][] = [
    ['Node', () => createElement(NodeInfo, { name: 'n1' }), ['cluster', 'nodes', 'describe', 'n1'], en.nodes.detail.error],
    ['Namespace', () => createElement(NamespaceInfo, { name: 'ns-b' }), ['namespace-describe', 'ns-b'], en.namespaces.detail.error],
    ['custom resource', () => createElement(CustomResourceInstanceInfo, { name: 'gc', namespace: 'ns-b', rawJson: crRaw }), crKey, 'Basic Info'],
  ]
  for (const [what, view, key, other] of views) {
    it(`${what}: refused (403) → the notice, not "${other}"`, () => {
      const html = render(view(), [[key, failed(403)]])
      expect(notice(html)).toBe('forbidden')
      expect(html).not.toContain(other)
    })

    it(`${what}: another failure (500) is drawn as before`, () => {
      const html = render(view(), [[key, failed(500)]])
      expect(notice(html)).toBe('no notice')
      expect(html).toContain(other)
    })
  }

  it('custom resource: gone (404) → the "does not exist" notice, not empty sections', () => {
    const html = render(createElement(CustomResourceInstanceInfo, { name: 'gc', namespace: 'ns-b', rawJson: crRaw }), [[crKey, failed(404)]])
    expect(html.includes(NOTICE) ? (html.includes(en.common.objectNotFound) ? 'not found' : 'another notice') : 'no notice').toBe('not found')
    expect(html).not.toContain('Basic Info')
    expect(layers.filter((l) => l.source === 'DetailUnreadable').map((l) => l.data?.unreadable)).toEqual(['not_found'])
  })

  it('the floating chat is told the object is refused (the notice\'s layer)', () => {
    render(createElement(NodeInfo, { name: 'n1' }), [[['cluster', 'nodes', 'describe', 'n1'], failed(403)]])
    render(createElement(CustomResourceInstanceInfo, { name: 'gc', namespace: 'ns-b', rawJson: crRaw }), [[crKey, failed(403)]])
    expect(layers.filter((l) => l.source === 'DetailUnreadable').map((l) => l.data)).toEqual([
      { kind: 'Node', name: 'n1', namespace: undefined, unreadable: 'forbidden' },
      { kind: 'GuardCheck', name: 'gc', namespace: 'ns-b', unreadable: 'forbidden' },
    ])
  })
})
