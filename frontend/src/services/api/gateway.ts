// Gateway API objects — Gateway / GatewayClass / HTTPRoute / GRPCRoute
// / ReferenceGrant / BackendTLSPolicy, plus the implementation-neutral
// policy list (gateway-policies). These belong to the gateway.networking.k8s.io
// API group, not the legacy Ingress / Service surface in network.ts.

import { client } from './client'
import type {
  BackendTLSPolicyInfo,
  GatewayPoliciesResponse,
  GRPCRouteInfo,
  GatewayClassInfo,
  GatewayInfo,
  HTTPRouteInfo,
  ReferenceGrantInfo,
} from './types'

export const gatewayApi = {
  // Gateways
  getGateways: async (namespace: string, forceRefresh = false): Promise<GatewayInfo[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/gateways`, {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getAllGateways: async (forceRefresh = false): Promise<GatewayInfo[]> => {
    const { data } = await client.get('/cluster/gateways/all', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeGateway: async (namespace: string, name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/gateways/${name}/describe`)
    return data
  },

  deleteGateway: async (namespace: string, name: string): Promise<void> => {
    await client.delete(`/cluster/namespaces/${namespace}/gateways/${name}`)
  },

  // GatewayClasses
  getGatewayClasses: async (forceRefresh = false): Promise<GatewayClassInfo[]> => {
    const { data } = await client.get('/cluster/gatewayclasses', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeGatewayClass: async (name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/gatewayclasses/${name}/describe`)
    return data
  },

  deleteGatewayClass: async (name: string): Promise<void> => {
    await client.delete(`/cluster/gatewayclasses/${name}`)
  },

  // HTTPRoutes
  getHTTPRoutes: async (namespace: string, forceRefresh = false): Promise<HTTPRouteInfo[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/httproutes`, {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getAllHTTPRoutes: async (forceRefresh = false): Promise<HTTPRouteInfo[]> => {
    const { data } = await client.get('/cluster/httproutes/all', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeHTTPRoute: async (namespace: string, name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/httproutes/${name}/describe`)
    return data
  },

  deleteHTTPRoute: async (namespace: string, name: string): Promise<void> => {
    await client.delete(`/cluster/namespaces/${namespace}/httproutes/${name}`)
  },

  // GRPCRoutes
  getGRPCRoutes: async (namespace: string, forceRefresh = false): Promise<GRPCRouteInfo[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/grpcroutes`, {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getAllGRPCRoutes: async (forceRefresh = false): Promise<GRPCRouteInfo[]> => {
    const { data } = await client.get('/cluster/grpcroutes/all', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeGRPCRoute: async (namespace: string, name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/grpcroutes/${name}/describe`)
    return data
  },

  deleteGRPCRoute: async (namespace: string, name: string): Promise<void> => {
    await client.delete(`/cluster/namespaces/${namespace}/grpcroutes/${name}`)
  },

  // ReferenceGrants
  getReferenceGrants: async (namespace: string, forceRefresh = false): Promise<ReferenceGrantInfo[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/referencegrants`, {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getAllReferenceGrants: async (forceRefresh = false): Promise<ReferenceGrantInfo[]> => {
    const { data } = await client.get('/cluster/referencegrants/all', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeReferenceGrant: async (namespace: string, name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/referencegrants/${name}/describe`)
    return data
  },

  deleteReferenceGrant: async (namespace: string, name: string): Promise<void> => {
    await client.delete(`/cluster/namespaces/${namespace}/referencegrants/${name}`)
  },

  // BackendTLSPolicies
  getBackendTLSPolicies: async (namespace: string, forceRefresh = false): Promise<BackendTLSPolicyInfo[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/backendtlspolicies`, {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getAllBackendTLSPolicies: async (forceRefresh = false): Promise<BackendTLSPolicyInfo[]> => {
    const { data } = await client.get('/cluster/backendtlspolicies/all', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeBackendTLSPolicy: async (namespace: string, name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/backendtlspolicies/${name}/describe`)
    return data
  },

  deleteBackendTLSPolicy: async (namespace: string, name: string): Promise<void> => {
    await client.delete(`/cluster/namespaces/${namespace}/backendtlspolicies/${name}`)
  },

  // Policies of every implementation (label-discovered CRDs + Envoy Gateway /
  // Istio built-ins + configured kinds). Rows are plain custom resources, so
  // describe / YAML / delete go through the custom-resources API.
  getGatewayPolicies: async (namespace: string): Promise<GatewayPoliciesResponse> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/gateway-policies`)
    return data
  },

  getAllGatewayPolicies: async (): Promise<GatewayPoliciesResponse> => {
    const { data } = await client.get('/cluster/gateway-policies/all')
    return data
  },
}
