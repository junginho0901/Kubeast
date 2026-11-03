import fs from 'node:fs'
import path from 'node:path'

// The number check's Gateway API objects on test2 — number-check.gateway-fixture.yaml and the statuses a controller
// would write (none runs there) — which number-check-lists.spec.ts and number-check-gateway-drawers.spec.ts both make.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = any
type Kubectl = (args: string, input?: string) => string

export const GW = 'gateway.networking.k8s.io'
const FIXTURE = fs.readFileSync(path.join(__dirname, 'number-check.gateway-fixture.yaml'), 'utf8')
// the fixture at the versions the cluster serves the kinds at, in namespace ns
export const gatewayFixture = (served: Record<string, string>, ns: string) =>
  FIXTURE.replace(/\{\{(\w+)\}\}/g, (_, k) => served[k]).replace(/\be2e-numbers\b/g, ns)

// the versions test2 serves the kinds at (they move between Gateway API releases), or null without them
export function gatewayVersions(kubectl: Kubectl): Record<string, string> | null {
  try {
    const served = Object.fromEntries(kubectl(`api-resources --api-group=${GW} --no-headers`).split('\n')
      .map((line) => line.trim().split(/\s+/))
      .map((cols) => [cols[0], cols.find((c) => c.startsWith(`${GW}/`))?.split('/')[1] ?? '']))
    const kinds = ['gatewayclasses', 'gateways', 'httproutes', 'grpcroutes', 'referencegrants', 'backendtlspolicies']
    return kinds.every((k) => served[k]) ? served : null
  } catch {
    return null
  }
}
// a condition list summed up as the list pages show it: the named conditions that hold first, then the first that
// holds, then the first that does not as "<type>(False)", else Unknown
export const summary = (conds: Obj[] = [], ...first: string[]) => {
  const named = first.find((t) => conds.some((c) => c.type === t && c.status === 'True'))
  const yes = conds.find((c) => c.status === 'True')
  const no = conds.find((c) => c.status === 'False')
  return named ?? yes?.type ?? (no ? `${no.type}(False)` : 'Unknown')
}
// a route's conditions over every parent it reports on
export const routeConds = (o: Obj): Obj[] => (o.status?.parents ?? []).flatMap((p: Obj) => p.conditions ?? [])

// the statuses a controller would write (none runs on test2); num-gc-plain, num-gw-b and the routes not named keep
// the CRDs' default or none
export const condition = (type: string, status: string, reason = status === 'True' ? type : 'Pending') =>
  ({ type, status, reason, message: '', lastTransitionTime: '2026-11-01T00:00:00Z' })
const CONTROLLER = 'numbers.kubeast.io/gateway'
const listener = (name: string, attachedRoutes: number) =>
  ({ name, attachedRoutes, supportedKinds: [{ group: GW, kind: 'HTTPRoute' }], conditions: [condition('Programmed', 'True')] })
const parent = (name: string, conditions: Obj[]) => ({ parentRef: { name }, controllerName: CONTROLLER, conditions })
export const ancestor = (name: string, conditions: Obj[]) => ({ ancestorRef: { name }, controllerName: CONTROLLER, conditions })
export const GATEWAY_STATUS: [string, string, Obj][] = [
  ['gatewayclass', 'num-gc-ready', { conditions: [condition('Accepted', 'True')] }],
  ['gateway', 'num-gw-a', {
    conditions: [condition('Accepted', 'True'), condition('Programmed', 'True')],
    listeners: [listener('http', 2), listener('alt', 1)],
    addresses: [{ type: 'IPAddress', value: '10.0.0.7' }, { type: 'Hostname', value: 'gw.numbers.example' }],
  }],
  ['gateway', 'num-gw-c', {
    conditions: [condition('Accepted', 'True'), condition('Programmed', 'False')],
    listeners: [listener('web', 1), listener('api', 0), listener('admin', 0)],
  }],
  ['httproute', 'num-http-a', { parents: [parent('num-gw-a', [condition('Accepted', 'False')]), parent('num-gw-c', [condition('Accepted', 'True'), condition('ResolvedRefs', 'True')])] }],
  ['httproute', 'num-http-b', { parents: [parent('num-gw-a', [condition('ResolvedRefs', 'False'), condition('Accepted', 'False')])] }],
  ['grpcroute', 'num-grpc-a', { parents: [parent('num-gw-a', [condition('Accepted', 'True'), condition('ResolvedRefs', 'False')])] }],
  ['backendtlspolicy', 'num-btls-a', { ancestors: [ancestor('num-gw-a', [condition('Accepted', 'True')])] }],
  ['backendtlspolicy', 'num-btls-b', { ancestors: [ancestor('num-gw-c', [condition('Accepted', 'False', 'NoValidCACertificate')])] }],
]
// a JSON patch or body as one shell word
export const arg = (v: unknown) => JSON.stringify(JSON.stringify(v))
// GATEWAY_STATUS written to the fixture in namespace ns
export function writeGatewayStatus(kubectl: Kubectl, ns: string) {
  for (const [kind, name, status] of GATEWAY_STATUS) {
    kubectl(`patch ${kind} ${name}${kind === 'gatewayclass' ? '' : ` -n ${ns}`} --subresource=status --type=merge -p=${arg({ status })}`)
  }
}
