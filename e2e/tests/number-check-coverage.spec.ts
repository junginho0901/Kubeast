import fs from 'node:fs'
import path from 'node:path'

import { test, expect } from '@playwright/test'

// Every screen the sidebar lists has its numbers compared with the cluster (or Kubeast's own API and database), or
// says why not. A new menu entry fails here until it is placed; a screen marked as compared must be in that spec.

const repo = path.join(__dirname, '..', '..')
const sidebar = [...fs.readFileSync(path.join(repo, 'frontend/src/components/Layout.tsx'), 'utf8').matchAll(/href: '([^']+)'/g)].map((m) => m[1])

// where each screen's numbers are compared: a spec file whose screens list has the path, or the step that will
const WHERE: Record<string, string> = {
  '/workloads/pods': 'number-check-lists', '/workloads/deployments': 'number-check-lists', '/workloads/statefulsets': 'number-check-lists',
  '/workloads/daemonsets': 'number-check-lists', '/workloads/replicasets': 'number-check-lists', '/workloads/jobs': 'number-check-lists',
  '/workloads/cronjobs': 'number-check-lists', '/workloads/hpas': 'number-check-lists', '/workloads/pdbs': 'number-check-lists',
  '/network/services': 'number-check-lists', '/network/endpoints': 'number-check-lists', '/network/endpointslices': 'number-check-lists',
  '/network/ingresses': 'number-check-lists', '/network/networkpolicies': 'number-check-lists', '/storage?tab=pvcs': 'number-check-lists',
  '/configuration/configmaps': 'number-check-lists', '/configuration/secrets': 'number-check-lists', '/security/serviceaccounts': 'number-check-lists',
  '/security/roles': 'number-check-lists', '/security/rolebindings': 'number-check-lists', '/cluster/resourcequotas': 'number-check-lists',
  '/cluster/limitranges': 'number-check-lists',
  // cluster-scoped lists
  '/cluster/namespaces': 'number-check-lists', '/cluster/nodes': 'number-check-lists', '/storage?tab=pvs': 'number-check-lists',
  '/storage?tab=storageclasses': 'number-check-lists', '/storage?tab=volumeattachments': 'number-check-lists',
  '/network/ingressclasses': 'number-check-lists', '/cluster/priorityclasses': 'number-check-lists', '/cluster/runtimeclasses': 'number-check-lists',
  '/security/clusterroles': 'number-check-lists', '/security/clusterrolebindings': 'number-check-lists', '/cluster/leases': 'number-check-lists',
  '/cluster/mutatingwebhookconfigurations': 'number-check-lists', '/cluster/validatingwebhookconfigurations': 'number-check-lists',
  '/cluster/validatingadmissionpolicies': 'number-check-lists', '/cluster/mutatingadmissionpolicies': 'number-check-lists',
  '/custom-resources/groups': 'number-check-lists',
  // lists whose kinds self does not serve (Gateway API, VPA) or other specs expect it not to (PolicyReport): another cluster
  '/workloads/vpas': 'N3-a', '/custom-resources/instances': 'N3-a', '/security/policyreports': 'N3-a',
  '/gateway/gatewayclasses': 'N3-a', '/gateway/gateways': 'N3-a', '/gateway/httproutes': 'N3-a', '/gateway/grpcroutes': 'N3-a',
  '/gateway/referencegrants': 'N3-a', '/gateway/backendtlspolicies': 'N3-a', '/gateway/policies': 'N3-a',
  // summary screens
  '/': 'N3-b', '/cluster-view': 'N3-b', '/helm/releases': 'N3-b', '/timeline': 'N3-b', '/monitoring': 'N3-b', '/cluster/search': 'N3-b',
  '/admin/cluster-hygiene': 'N3-b', '/cluster/resource-graph': 'N3-b', '/cost': 'N3-b',
  '/gpu/dashboard': 'N3-c (GPU)', '/gpu/nodes': 'N3-c (GPU)', '/gpu/pods': 'N3-c (GPU)', '/gpu/deviceclasses': 'N3-c (GPU)',
  '/gpu/resourceclaims': 'N3-c (GPU)', '/gpu/resourceclaimtemplates': 'N3-c (GPU)', '/gpu/resourceslices': 'N3-c (GPU)',
  // Kubeast's own data: screen = API and database
  '/admin/users': 'N4', '/admin/roles': 'N4', '/admin/organizations': 'N4', '/admin/clusters': 'N4', '/admin/ai-models': 'N4',
  '/admin/ai-usage': 'N4', '/admin/audit': 'N4', '/admin/access-requests': 'N4', '/admin/access-review': 'N4',
  '/admin/investigations': 'N4', '/admin/session-recordings': 'N4', '/admin/node-shell': 'N4', '/alerts': 'N4', '/ai-chat': 'N4',
}

test('every sidebar screen has a place in the number check', () => {
  expect(sidebar.length, 'menu entries read from Layout.tsx').toBeGreaterThan(70)
  expect(sidebar.filter((p) => !(p in WHERE)), 'menu entries with no place').toEqual([])
  expect(Object.keys(WHERE).filter((p) => !sidebar.includes(p)), 'places for menu entries that are gone').toEqual([])
  const specs: Record<string, string> = {}
  const missing = Object.entries(WHERE).filter(([p, where]) => {
    if (!where.startsWith('number-check-')) return false
    specs[where] ??= fs.readFileSync(path.join(__dirname, `${where}.spec.ts`), 'utf8')
    return !specs[where].includes(`path: '${p}'`)
  })
  expect(missing, 'screens marked as compared that their spec does not list').toEqual([])
})
