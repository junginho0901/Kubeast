import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { CRDInfo, PolicyReportResult, OptimizationRow } from '@/services/api/types'
import type { HygieneFinding } from '@/services/api/hygiene'
import { ResourceDetailContext, type ResourceDetailTarget } from '../ResourceDetailContext'
import { apiParam, toParam } from '../detailParam'
import { toSearchResult } from '../search/searchEngine'
import { issueTarget, toIssueItem } from '@/pages/dashboard/issues'
import { alertResource } from '@/utils/alertInbox'
import { hygieneFindingTarget, optimizationRowTarget, policyResultTarget } from '@/utils/detailTargets'
import { customResourceTarget } from './crDetail'
import { ResourceLink } from './ResourceLink'

// Every place that opens a drawer from a row or a reference passes the object's apiVersion where it has one, so the
// same Kind of two groups (the number check's Widget of links-a and links-b, both named dl-w in e2e-detail-links)
// opens each group's object with its own CRD; a built-in kind's link stays ?detail=<Kind>/<namespace>/<name>.

const crd = (name: string, kind: string, scope = 'Namespaced'): CRDInfo => ({
  name, kind, version: 'v1', served_versions: ['v1'], group: name.slice(name.indexOf('.') + 1), scope,
})
const CRDS: CRDInfo[] = [
  crd('widgets.links-a.kubeast.io', 'Widget'), crd('widgets.links-b.kubeast.io', 'Widget'),
  crd('gizmos.links-a.kubeast.io', 'Gizmo', 'Cluster'), crd('gizmos.links-b.kubeast.io', 'Gizmo', 'Cluster'),
]
const NS = 'e2e-detail-links'
// what the drawer opens once it has read the CRD list: the custom resource as detailParam names it, and its CRD
const opened = (t: ResourceDetailTarget | null) => {
  if (!t) return null
  const cr = customResourceTarget(t, CRDS)
  return { detail: toParam(cr), detailApi: apiParam(cr) || undefined, crd: cr.rawJson?.crd_name }
}
const widget = (group: string) => ({ detail: `Widget/${NS}/dl-w`, detailApi: `${group}/v1/widgets`, crd: `widgets.${group}` })

describe('Policy Reports: a result row opens the resource with the apiVersion the server gives', () => {
  const row = (r: Partial<PolicyReportResult>): PolicyReportResult => ({ namespace: NS, kind: 'Widget', name: 'dl-w', policy: 'p', result: 'fail', report: 'r', ...r })

  it('each group\'s Widget with its own CRD', () => {
    expect(opened(policyResultTarget(row({ api_version: 'links-a.kubeast.io/v1' })))).toEqual(widget('links-a.kubeast.io'))
    expect(opened(policyResultTarget(row({ api_version: 'links-b.kubeast.io/v1' })))).toEqual(widget('links-b.kubeast.io'))
  })

  it('a built-in kind as before, a cluster-scoped one without a namespace, a row naming nothing opens nothing', () => {
    expect(policyResultTarget(row({ kind: 'Pod', name: 'p1', api_version: 'v1' }))).toEqual({ kind: 'Pod', name: 'p1', namespace: NS })
    expect(policyResultTarget(row({ kind: 'Namespace', name: 'apps', namespace: '', api_version: 'v1' }))).toEqual({ kind: 'Namespace', name: 'apps', namespace: undefined })
    expect(policyResultTarget(row({ kind: '', name: '' }))).toBeNull()
  })
})

describe('Issues: a row an event made opens the event\'s object with its apiVersion', () => {
  const item = (apiVersion?: string) => toIssueItem({ id: `Widget.x/${NS}/dl-w`, kind: 'Widget', namespace: NS, name: 'dl-w', severity: 'warning', api_version: apiVersion })

  it('keeps the api_version the server gives and opens each group\'s Widget', () => {
    expect(item('links-a.kubeast.io/v1').apiVersion).toBe('links-a.kubeast.io/v1')
    expect(opened(issueTarget(item('links-a.kubeast.io/v1')))).toEqual(widget('links-a.kubeast.io'))
    expect(opened(issueTarget(item('links-b.kubeast.io/v1')))).toEqual(widget('links-b.kubeast.io'))
  })

  it('a check\'s row as before; a Collector row opens nothing', () => {
    expect(issueTarget(toIssueItem({ id: 'Pod/a/web', kind: 'Pod', namespace: 'a', name: 'web', severity: 'warning' }))).toEqual({ kind: 'Pod', name: 'web', namespace: 'a' })
    expect(issueTarget(toIssueItem({ id: 'Collector/jobs', kind: 'Collector', name: 'jobs', severity: 'info' }))).toBeNull()
  })
})

describe('Cluster Hygiene and Optimization: a workload row opens its owner with the owner\'s apiVersion', () => {
  const finding = (f: Partial<HygieneFinding>): HygieneFinding => ({ check: 'resources.memory-limit', severity: 'warning', kind: 'Widget', namespace: NS, name: 'dl-w', message: 'no memory limit', ...f })
  const row = (r: Partial<OptimizationRow>) => ({ kind: 'Widget', namespace: NS, name: 'dl-w', container: 'app', pods: 1, ...r }) as OptimizationRow

  it('each group\'s Widget with its own CRD', () => {
    for (const group of ['links-a.kubeast.io', 'links-b.kubeast.io']) {
      expect(opened(hygieneFindingTarget(finding({ api_version: `${group}/v1` }))), `hygiene ${group}`).toEqual(widget(group))
      expect(opened(optimizationRowTarget(row({ api_version: `${group}/v1` }))), `optimization ${group}`).toEqual(widget(group))
    }
  })

  it('a Deployment as before; an API finding opens nothing', () => {
    expect(hygieneFindingTarget(finding({ kind: 'Deployment', name: 'web', api_version: 'apps/v1' }))).toEqual({ kind: 'Deployment', name: 'web', namespace: NS })
    expect(optimizationRowTarget(row({ kind: 'Deployment', name: 'web', api_version: 'apps/v1' }))).toEqual({ kind: 'Deployment', name: 'web', namespace: NS })
    expect(hygieneFindingTarget(finding({ kind: 'API', name: 'flowcontrol.apiserver.k8s.io/v1beta3/flowschemas', namespace: undefined }))).toBeNull()
  })
})

describe('Alerts inbox: a custom resource state alert opens the custom resource', () => {
  const ksm = { customresource_group: 'links-b.kubeast.io', customresource_version: 'v1', customresource_kind: 'Widget' }

  it('by kube-state-metrics\' customresource_* labels and the object\'s name label', () => {
    expect(opened(alertResource({ alertname: 'WidgetNotReady', namespace: NS, name: 'dl-w', ...ksm }))).toEqual(widget('links-b.kubeast.io'))
    expect(opened(alertResource({ alertname: 'WidgetNotReady', namespace: NS, widget: 'dl-w', ...ksm, customresource_group: 'links-a.kubeast.io' }))).toEqual(widget('links-a.kubeast.io'))
    expect(opened(alertResource({ alertname: 'GizmoDown', name: 'dl-g', ...ksm, customresource_kind: 'Gizmo' }))).toEqual({ detail: 'Gizmo/dl-g', detailApi: 'links-b.kubeast.io/v1/gizmos', crd: 'gizmos.links-b.kubeast.io' })
  })

  it('without the object\'s name or group, the other labels as before', () => {
    expect(alertResource({ namespace: NS, deployment: 'web', ...ksm })).toEqual({ kind: 'Deployment', namespace: NS, name: 'web' })
    expect(alertResource({ namespace: NS, name: 'dl-w', ...ksm, customresource_group: '' })).toBeNull()
  })
})

describe('Advanced Search: a cluster-scoped object opens as <Kind>/<name>', () => {
  const gizmo = (group: string) => ({ apiVersion: `${group}/v1`, kind: 'Gizmo', metadata: { name: 'dl-g' }, spec: {} })

  it('its namespace is empty, so each group\'s Gizmo opens with its own CRD', () => {
    for (const group of ['links-a.kubeast.io', 'links-b.kubeast.io']) {
      const r = toSearchResult(gizmo(group))
      expect(r.namespace).toBe('')
      // as SearchResultTable opens a result
      const t = customResourceTarget({ kind: r.kind, name: r.name, namespace: r.namespace || undefined, apiVersion: `${group}/v1`, rawJson: r.raw }, CRDS)
      expect({ detail: toParam(t), detailApi: apiParam(t), namespace: t.namespace }).toEqual({ detail: 'Gizmo/dl-g', detailApi: `${group}/v1/gizmos`, namespace: undefined })
    }
    expect(toSearchResult({ kind: 'ConfigMap', metadata: { name: 'c', namespace: NS } }).namespace).toBe(NS)
  })
})

describe('ResourceLink: a reference with an apiVersion (an owner, a scale target) opens that group\'s object', () => {
  // the button ResourceLink draws, rendered in a drawer's context, clicked
  const click = (props: { kind: string; name: string; namespace?: string; apiVersion?: string }) => {
    const asked: ResourceDetailTarget[] = []
    let button: ReactElement<{ onClick: (e: { stopPropagation: () => void }) => void }> | null = null
    const Grab = () => {
      button = ResourceLink(props) as typeof button
      return null
    }
    renderToStaticMarkup(createElement(ResourceDetailContext.Provider, {
      value: { target: null, open: (t) => asked.push(t), close: () => {}, goBack: () => {}, canGoBack: false },
    }, createElement(Grab)))
    button!.props.onClick({ stopPropagation: () => {} })
    return asked[0]
  }

  it('each group\'s Widget owner with its own CRD', () => {
    expect(opened(click({ kind: 'Widget', name: 'dl-w', namespace: NS, apiVersion: 'links-a.kubeast.io/v1' }))).toEqual(widget('links-a.kubeast.io'))
    expect(opened(click({ kind: 'Widget', name: 'dl-w', namespace: NS, apiVersion: 'links-b.kubeast.io/v1' }))).toEqual(widget('links-b.kubeast.io'))
  })

  it('a built-in owner or a reference without one as before', () => {
    expect(click({ kind: 'ReplicaSet', name: 'web-1', namespace: NS, apiVersion: 'apps/v1' })).toEqual({ kind: 'ReplicaSet', name: 'web-1', namespace: NS })
    expect(click({ kind: 'Node', name: 'n1' })).toEqual({ kind: 'Node', name: 'n1', namespace: undefined })
  })
})
