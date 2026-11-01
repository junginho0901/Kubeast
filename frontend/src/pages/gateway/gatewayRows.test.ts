import { describe, expect, it } from 'vitest'
import type { BackendTLSPolicyInfo, GatewayClassInfo, GatewayInfo, GRPCRouteInfo, HTTPRouteInfo, ReferenceGrantInfo } from '@/services/api'
import { applyWatchEvent } from './backend-policies/helpers'
import { applyGatewayClassWatchEvent, normalizeWatchGatewayClassObject } from './gatewayclasses/gatewayClassWatchNormalize'
import { applyGatewayWatchEvent } from './gateways/gatewayWatchNormalize'
import { applyGRPCRouteWatchEvent } from './grpcroutes/grpcRouteWatchNormalize'
import { applyHTTPRouteWatchEvent } from './httproutes/httpRouteWatchNormalize'
import { applyReferenceGrantWatchEvent } from './referencegrants/referenceGrantWatchNormalize'

const accepted = [{ type: 'Accepted', status: 'True' }]

// The server sends a Gateway API object's whole list row (gatewayrow) as its live update, so the row is replaced:
// a value that went empty — no hostnames, no conditions, no parameters — shows empty instead of the old one.
describe('Gateway API rows on a live update', () => {
  it('a route that lost its hostnames and conditions shows none', () => {
    const before = { name: 'web', namespace: 'shop', rule_count: 1, hostnames: ['shop.example.com'], status: 'Accepted', accepted: true, conditions: accepted }
    const after = { ...before, hostnames: [], status: 'Unknown', accepted: false, conditions: [] }
    for (const apply of [applyHTTPRouteWatchEvent, applyGRPCRouteWatchEvent] as const) {
      const [row] = apply([before as HTTPRouteInfo & GRPCRouteInfo], { type: 'MODIFIED', object: after })
      expect(row.hostnames).toEqual([])
      expect(row.status).toBe('Unknown')
      expect(row.conditions).toEqual([])
    }
  })

  it('a Gateway whose conditions went shows Unknown', () => {
    const before = { name: 'edge', namespace: 'shop', listeners_count: 2, attached_routes: 3, addresses_count: 1, status: 'Programmed', programmed: true, conditions: accepted }
    const [row] = applyGatewayWatchEvent([before as GatewayInfo], { type: 'MODIFIED', object: { ...before, addresses_count: 0, status: 'Unknown', programmed: false, conditions: [] } })
    expect(row.status).toBe('Unknown')
    expect(row.addresses_count).toBe(0)
  })

  it('a GatewayClass without parameters any more shows none; its description is spec.description', () => {
    const before = { name: 'eg', controller_name: 'example.com/gw', parameters_ref: { kind: 'Config', name: 'p' }, status: 'Accepted' }
    const [row] = applyGatewayClassWatchEvent([before as GatewayClassInfo], { type: 'MODIFIED', object: { ...before, parameters_ref: null } })
    expect(row.parameters_ref).toBeNull()
    expect(normalizeWatchGatewayClassObject({ metadata: { name: 'eg' }, spec: { controllerName: 'x', description: 'edge' } }).description).toBe('edge')
  })

  it('a ReferenceGrant and a BackendTLSPolicy are replaced too', () => {
    const grant = { name: 'g', namespace: 'shop', from: [{ group: '', kind: 'HTTPRoute', namespace: 'web' }], to: [{ group: '', kind: 'Service', name: 'api' }], labels: { team: 'web' } }
    const [g] = applyReferenceGrantWatchEvent([grant as ReferenceGrantInfo], { type: 'MODIFIED', object: { ...grant, labels: {} } })
    expect(g.labels).toEqual({})
    const policy = { name: 'p', namespace: 'shop', target_refs: [{ kind: 'Service', name: 'api' }], conditions: accepted }
    const [p] = applyWatchEvent([policy as BackendTLSPolicyInfo], { type: 'MODIFIED', object: { ...policy, conditions: [] } })
    expect(p.conditions).toEqual([])
  })
})
