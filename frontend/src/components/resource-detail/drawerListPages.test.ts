import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import RoleBindingInfo from './RoleBindingInfo'
import ClusterRoleBindingInfo from './ClusterRoleBindingInfo'
import EndpointDetail from './network-info/EndpointDetail'
import EndpointSliceDetail from './network-info/EndpointSliceDetail'
import ServiceInfo from './ServiceInfo'
import WorkloadReplicasSection from './workload-info/WorkloadReplicasSection'
import PolicyViolations from './PolicyViolations'
import AdmissionPolicyInfo from './AdmissionPolicyInfo'
import NetworkPolicies from './NetworkPolicies'
import RoleInfo from './RoleInfo'
import ClusterRoleInfo from './ClusterRoleInfo'

// A drawer list that grows with the cluster draws ten rows at a time with the drawers' pager ("1-10 / N"), and one
// that fits a page draws whole without it; counts, badges and what the floating chat is told stay totals. A Role's
// rules stay whole, marked as bounded by the one object.

const ai = vi.hoisted(() => ({ layers: [] as Array<{ source: string; data: Record<string, any> }> }))
vi.mock('@/hooks/useAIContext', () => ({
  useAIContext: (snapshot: { source: string; data: Record<string, any> } | null) => {
    if (snapshot) ai.layers.push(snapshot)
  },
}))
vi.mock('@/components/ResourceDetailContext', () => ({ useResourceDetail: () => ({ open: () => {} }) }))
vi.mock('./useDrawerFollowsObject', () => ({ useDrawerFollowsObject: () => {} }))
vi.mock('./useNamespacePodTable', () => ({ useNamespacePodTable: () => ({ items: [], total: 0, loading: false, nav: null, note: null }) }))
vi.mock('./useServerPods', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./useServerPods')>()),
  useServerPods: () => ({ items: [], total: 0, isLoading: false, nav: null }),
}))
vi.mock('./role-info/useReverseRoleBindings', () => ({ useReverseRoleBindings: () => ({ bindings: [], error: null }) }))
vi.mock('@/hooks/usePermission', () => ({ usePermission: () => ({ has: () => true, clusterNamespaces: {} }) }))
vi.mock('@/hooks/usePrometheusQuery', () => ({
  usePrometheusQueries: () => ({ available: false, data: {} }),
  useClusterFeatures: () => ({ data: { policyReports: { enabled: true } } }),
}))

const pad = (i: number) => String(i).padStart(2, '0')
const range = (n: number) => Array.from({ length: n }, (_, i) => i)

function draw(el: ReactElement, seed: (qc: QueryClient) => void = () => {}): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } })
  seed(qc)
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, el))
}
// the distinct names of a pattern the markup draws, in the order it draws them first
function shown(html: string, re: RegExp): string[] {
  return [...new Set([...html.matchAll(re)].map((m) => m[0]))]
}
const pagerOf = (total: number) => `<span>1-10 / ${total}</span>`
const noPager = (html: string) => !/<span>\d+-\d+ \/ \d+<\/span>/.test(html)

beforeEach(() => {
  ai.layers = []
})

describe('a binding drawer\'s Subjects', () => {
  const subjects = (n: number) => range(n).map((i) => (i < n - 3
    ? { kind: 'User', apiGroup: 'rbac.authorization.k8s.io', name: `subj-${pad(i)}` }
    : { kind: 'ServiceAccount', name: `subj-${pad(i)}`, namespace: 'ns' }))
  const roleBinding = (n: number) => draw(createElement(RoleBindingInfo, { name: 'rb', namespace: 'ns' }), (qc) =>
    qc.setQueryData(['rolebinding-describe', 'ns', 'rb'], { role_ref_kind: 'Role', role_ref_name: 'r', subjects: subjects(n) }))
  const clusterRoleBinding = (n: number) => draw(createElement(ClusterRoleBindingInfo, { name: 'crb' }), (qc) =>
    qc.setQueryData(['clusterrolebinding-describe', 'crb'], { role_ref_kind: 'ClusterRole', role_ref_name: 'r', subjects: subjects(n) }))

  for (const [kind, render] of [['RoleBinding', roleBinding], ['ClusterRoleBinding', clusterRoleBinding]] as const) {
    it(`${kind}: ten subjects to a page with the range of all, the title and kind counts of all`, () => {
      const html = render(23)
      expect(shown(html, /subj-\d\d/g)).toEqual(range(10).map((i) => `subj-${pad(i)}`))
      expect(html).toContain(pagerOf(23))
      expect(html).toContain('Subjects (23)')
      expect(html).toContain('User: <span class="font-mono">20</span>')
      expect(html).toContain('ServiceAccount: <span class="font-mono">3</span>')
    })

    it(`${kind}: subjects that fit a page are drawn whole without a pager`, () => {
      const html = render(7)
      expect(shown(html, /subj-\d\d/g)).toHaveLength(7)
      expect(noPager(html)).toBe(true)
    })
  }

  it('the floating chat is still told every subject of the binding', () => {
    roleBinding(23)
    const layer = ai.layers.filter((l) => l.source === 'RoleBindingInfo').pop()
    expect(layer?.data.subjects).toHaveLength(23)
  })
})

describe('an Endpoints drawer\'s targets', () => {
  const describe_ = {
    ready_count: 23, not_ready_count: 12,
    ready_addresses: range(23).map((i) => `10.1.0.${i}`), not_ready_addresses: range(12).map((i) => `10.2.0.${i}`),
    ready_targets: range(23).map((i) => ({ ip: `10.1.0.${i}`, target_ref: { kind: 'Pod', name: `web-${pad(i)}` } })),
    not_ready_targets: range(12).map((i) => ({ ip: `10.2.0.${i}` })),
    ports: [], subsets: [],
  }
  const render = (d: object) => draw(createElement(EndpointDetail, { name: 'web', namespace: 'ns', kind: 'Endpoints' }), (qc) =>
    qc.setQueryData(['endpoints-describe', 'ns', 'web'], d))

  it('draws ten ready and ten not-ready targets to a page, each with the range of all of its kind', () => {
    const html = render(describe_)
    expect(shown(html, /10\.1\.0\.\d+/g)).toEqual(range(10).map((i) => `10.1.0.${i}`))
    expect(shown(html, /10\.2\.0\.\d+/g)).toEqual(range(10).map((i) => `10.2.0.${i}`))
    expect(html).toContain(pagerOf(23))
    expect(html).toContain(pagerOf(12))
  })

  it('draws targets that fit a page whole, and keeps the counts of all', () => {
    const html = render({ ...describe_, ready_count: 3, ready_targets: describe_.ready_targets.slice(0, 3), not_ready_count: 0, not_ready_targets: [], not_ready_addresses: [] })
    expect(shown(html, /10\.1\.0\.\d+/g)).toHaveLength(3)
    expect(noPager(html)).toBe(true)
    expect(render(describe_)).toMatch(/Ready Addresses<\/span><span[^>]*>23</)
  })

  it('draws each subset\'s ready and not-ready addresses ten to a page, each with the range of all of its subset', () => {
    const html = render({
      ...describe_,
      subsets: [
        { addresses: range(23).map((i) => ({ ip: `10.7.0.${i}` })), not_ready_addresses: range(12).map((i) => ({ ip: `10.8.0.${i}` })), ports: [{ name: 'http', port: 80, protocol: 'TCP' }] },
        { addresses: range(3).map((i) => ({ ip: `10.9.0.${i}` })), not_ready_addresses: [], ports: [] },
      ],
    })
    expect(shown(html, /10\.7\.0\.\d+/g)).toEqual(range(10).map((i) => `10.7.0.${i}`))
    expect(shown(html, /10\.8\.0\.\d+/g)).toEqual(range(10).map((i) => `10.8.0.${i}`))
    expect(shown(html, /10\.9\.0\.\d+/g)).toEqual(range(3).map((i) => `10.9.0.${i}`))
    // the targets' two pagers, then the first subset's two; the second subset fits a page
    expect(html.match(/<span>1-10 \/ \d+<\/span>/g)).toEqual([pagerOf(23), pagerOf(12), pagerOf(23), pagerOf(12)])
  })

  it('pages the addresses of an answer without targets too', () => {
    const html = render({ ...describe_, ready_targets: [], not_ready_targets: [] })
    expect(shown(html, /10\.1\.0\.\d+/g)).toHaveLength(10)
    expect(html).toContain(pagerOf(23))
  })
})

describe('a Service drawer\'s endpoint addresses and slices', () => {
  const describe_ = (ready: number, notReady: number, slices: number) => ({
    endpoint_summary: {
      ready_count: ready, not_ready_count: notReady,
      ready_addresses: range(ready).map((i) => `10.3.0.${i}`), not_ready_addresses: range(notReady).map((i) => `10.4.0.${i}`),
    },
    endpoint_slices: range(slices).map((i) => ({ name: `svc-slice-${pad(i)}`, address_type: 'IPv4', endpoints_total: 2, endpoints_ready: 1, ports: [] })),
  })
  const render = (d: object) => draw(createElement(ServiceInfo, { name: 'svc', namespace: 'ns' }), (qc) => qc.setQueryData(['service-describe', 'ns', 'svc'], d))

  it('draws ten ready and ten not-ready addresses to a page with the range of all, the badges counting all', () => {
    const html = render(describe_(23, 12, 1))
    expect(shown(html, /10\.3\.0\.\d+/g)).toEqual(range(10).map((i) => `10.3.0.${i}`))
    expect(shown(html, /10\.4\.0\.\d+/g)).toEqual(range(10).map((i) => `10.4.0.${i}`))
    expect(html).toContain(pagerOf(23))
    expect(html).toContain(pagerOf(12))
    expect(html).toContain('Ready: 23')
    expect(html).toContain('Not Ready: 12')
  })

  it('draws ten slices to a page with the range of all, the Slices badge counting all', () => {
    const html = render(describe_(2, 0, 13))
    expect(shown(html, /svc-slice-\d\d/g)).toEqual(range(10).map((i) => `svc-slice-${pad(i)}`))
    expect(html).toContain(pagerOf(13))
    expect(html).toContain('Slices: 13')
  })

  it('draws addresses and slices that fit a page whole without a pager', () => {
    const html = render(describe_(4, 2, 3))
    expect(shown(html, /10\.3\.0\.\d+/g)).toHaveLength(4)
    expect(shown(html, /10\.4\.0\.\d+/g)).toHaveLength(2)
    expect(shown(html, /svc-slice-\d\d/g)).toHaveLength(3)
    expect(noPager(html)).toBe(true)
  })
})

describe('an EndpointSlice drawer\'s endpoints', () => {
  const rawJson = (n: number) => ({
    endpoints: range(n).map((i) => ({ addresses: [`10.5.0.${i}`], conditions: { ready: true } })),
    endpoints_total: n, endpoints_ready: n, ports: [],
  })
  const render = (n: number) => draw(createElement(EndpointSliceDetail, { name: 'slice', namespace: 'ns', rawJson: rawJson(n) }))

  it('draws ten endpoints to a page with the range of all, the count row counting all', () => {
    const html = render(23)
    expect(shown(html, /10\.5\.0\.\d+/g)).toEqual(range(10).map((i) => `10.5.0.${i}`))
    expect(html).toContain(pagerOf(23))
    expect(html).toContain('23 / 23')
  })

  it('draws endpoints that fit a page whole without a pager', () => {
    const html = render(6)
    expect(shown(html, /10\.5\.0\.\d+/g)).toHaveLength(6)
    expect(noPager(html)).toBe(true)
  })
})

describe('a workload drawer\'s per-pod CPU', () => {
  const render = (n: number) => draw(createElement(WorkloadReplicasSection, {
    isJob: false, isCronJob: false, isDaemonSet: false, isReplicaSet: false,
    replicaView: { desired: n, current: n, ready: n, updated: n, available: n },
    daemonSetStatus: { misscheduled: 0, unavailable: 0 },
    promWorkloadMetrics: {
      available: true,
      data: { cpu_per_pod: { available: true, results: range(n).map((i) => ({ metric: { pod: `web-${pad(i)}` }, value: i * 10 })) } },
    },
    getWorkloadMetric: () => null,
  }))

  it('draws the ten busiest pods first, with the range of every pod', () => {
    const html = render(23)
    expect(shown(html, /web-\d\d/g)).toEqual(range(10).map((i) => `web-${pad(22 - i)}`))
    expect(html).toContain(pagerOf(23))
  })

  it('draws pods that fit a page whole without a pager', () => {
    const html = render(4)
    expect(shown(html, /web-\d\d/g)).toEqual(['web-03', 'web-02', 'web-01', 'web-00'])
    expect(noPager(html)).toBe(true)
  })
})

describe('a drawer\'s policy violations', () => {
  const rows = (n: number) => range(n).map((i) => ({ namespace: 'ns', kind: 'ConfigMap', name: 'cm', policy: `pol-${pad(i)}`, rule: 'r', result: 'fail', message: `m${i}`, report: 'rep' }))
  const render = (n: number) => draw(createElement(PolicyViolations, { kind: 'ConfigMap', namespace: 'ns', name: 'cm' }), (qc) => {
    qc.setQueryData(['cluster', 'policyreports', 'status'], { installed: true })
    qc.setQueryData(['cluster', 'policyreports', 'resource', 'ns', 'ConfigMap', 'cm'], { rows: rows(n) })
  })
  const drawnRows = (html: string) => (html.match(/data-testid="policy-violation-row"/g) ?? []).length

  it('draws ten rows to a page with the range of all, and tells the floating chat every row', () => {
    const html = render(23)
    expect(drawnRows(html)).toBe(10)
    expect(shown(html, /pol-\d\d/g)).toEqual(range(10).map((i) => `pol-${pad(i)}`))
    expect(html).toContain(pagerOf(23))
    const layer = ai.layers.filter((l) => l.source === 'PolicyViolations').pop()
    expect(layer?.data.rows).toHaveLength(23)
  })

  it('draws rows that fit a page whole without a pager', () => {
    const html = render(4)
    expect(drawnRows(html)).toBe(4)
    expect(noPager(html)).toBe(true)
  })
})

describe('an admission policy drawer\'s bindings', () => {
  const render = (n: number) => draw(createElement(AdmissionPolicyInfo, { name: 'vap', kind: 'ValidatingAdmissionPolicy' }), (qc) =>
    qc.setQueryData(['admissionpolicy-describe', 'ValidatingAdmissionPolicy', 'vap'], {
      spec: {}, status: {}, bindings: range(n).map((i) => ({ name: `vap-binding-${pad(i)}`, spec: { validationActions: ['Audit'] } })),
    }))

  it('draws ten bindings to a page with the range of all, the badge counting all', () => {
    const html = render(13)
    expect(shown(html, /vap-binding-\d\d/g)).toEqual(range(10).map((i) => `vap-binding-${pad(i)}`))
    expect(html).toContain(pagerOf(13))
    expect(html).toContain('Bindings: 13')
  })

  it('draws bindings that fit a page whole without a pager', () => {
    const html = render(2)
    expect(shown(html, /vap-binding-\d\d/g)).toHaveLength(2)
    expect(noPager(html)).toBe(true)
  })
})

describe('a pod drawer\'s network policies', () => {
  const render = (ingress: number, egress: number) => draw(createElement(NetworkPolicies, { kind: 'Pod', namespace: 'ns', name: 'web' }), (qc) =>
    qc.setQueryData(['cluster', 'networkpolicies', 'effective', 'ns', 'Pod', 'web'], {
      kind: 'Pod', namespace: 'ns', name: 'web', host_network: false, unevaluated: [],
      ingress: { isolated: ingress > 0, policies: range(ingress).map((i) => ({ name: `np-in-${pad(i)}`, rules: [] })) },
      egress: { isolated: egress > 0, policies: range(egress).map((i) => ({ name: `np-out-${pad(i)}`, rules: [] })) },
    }))

  it('draws ten policies of a direction to a page with the range of all, its count of all', () => {
    const html = render(13, 3)
    expect(shown(html, /np-in-\d\d/g)).toEqual(range(10).map((i) => `np-in-${pad(i)}`))
    expect(html).toContain(pagerOf(13))
    expect(html).toContain('Isolated by 13 policies')
    expect(shown(html, /np-out-\d\d/g)).toHaveLength(3)
    expect(html).not.toContain(' / 3</span>')
  })
})

describe('a Role\'s rules, bounded by the one object', () => {
  const rules = range(23).map((i) => ({ apiGroups: [''], resources: [`res-${pad(i)}`], verbs: ['get'] }))

  it('Role: every rule is drawn, the list marked as bounded', () => {
    const html = draw(createElement(RoleInfo, { name: 'r', namespace: 'ns' }), (qc) => qc.setQueryData(['role-describe', 'ns', 'r'], { rules }))
    expect(shown(html, /res-\d\d/g)).toHaveLength(23)
    expect(html).toMatch(/data-list-bounded="[^"]+"/)
  })

  it('ClusterRole: every rule is drawn, the list marked as bounded', () => {
    const html = draw(createElement(ClusterRoleInfo, { name: 'cr' }), (qc) => qc.setQueryData(['clusterrole-describe', 'cr'], { rules }))
    expect(shown(html, /res-\d\d/g)).toHaveLength(23)
    expect(html).toMatch(/data-list-bounded="[^"]+"/)
  })
})
