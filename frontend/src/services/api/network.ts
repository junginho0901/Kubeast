// Network API — services / ingresses / ingress classes / endpoints /
// endpoint slices / network policies. Gateway API objects (Gateway,
// HTTPRoute, GRPCRoute, ReferenceGrant, BackendTLS/TrafficPolicy)
// live in gateway.ts.

import { client } from './client'
import type {
  EndpointInfo,
  EndpointSliceInfo,
  IngressClassInfo,
  IngressDetail,
  IngressInfo,
  NetworkPolicyInfo,
  ServiceInfo,
} from './types'

export const networkApi = {
  // Services
  getServices: async (namespace: string, forceRefresh = false): Promise<ServiceInfo[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/services`, {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getAllServices: async (forceRefresh = false): Promise<ServiceInfo[]> => {
    const { data } = await client.get('/cluster/services/all', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeService: async (namespace: string, name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/services/${name}/describe`)
    return data
  },

  deleteService: async (namespace: string, name: string): Promise<void> => {
    await client.delete(`/cluster/namespaces/${namespace}/services/${name}`)
  },

  // Ingresses
  getIngresses: async (namespace: string, forceRefresh = false): Promise<IngressInfo[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/ingresses`, {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getAllIngresses: async (forceRefresh = false): Promise<IngressInfo[]> => {
    const { data } = await client.get('/cluster/ingresses/all', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getIngressClasses: async (forceRefresh = false): Promise<IngressClassInfo[]> => {
    const { data } = await client.get('/cluster/ingressclasses', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getIngressDetail: async (namespace: string, name: string): Promise<IngressDetail> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/ingresses/${name}/detail`)
    return data
  },

  describeIngressClass: async (name: string): Promise<IngressClassInfo> => {
    const { data } = await client.get(`/cluster/ingressclasses/${name}/describe`)
    return data
  },

  listIngressesByClass: async (name: string): Promise<Array<{ name: string; namespace: string; created_at?: string }>> => {
    const { data } = await client.get(`/cluster/ingressclasses/${name}/ingresses`)
    return data
  },

  deleteIngress: async (namespace: string, name: string): Promise<void> => {
    await client.delete(`/cluster/namespaces/${namespace}/ingresses/${name}`)
  },

  deleteIngressClass: async (name: string): Promise<void> => {
    await client.delete(`/cluster/ingressclasses/${name}`)
  },

  // Endpoints
  getEndpoints: async (namespace: string, forceRefresh = false): Promise<EndpointInfo[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/endpoints`, {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getAllEndpoints: async (forceRefresh = false): Promise<EndpointInfo[]> => {
    const { data } = await client.get('/cluster/endpoints/all', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeEndpoint: async (namespace: string, name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/endpoints/${name}/describe`)
    return data
  },

  deleteEndpoint: async (namespace: string, name: string): Promise<void> => {
    await client.delete(`/cluster/namespaces/${namespace}/endpoints/${name}`)
  },

  // EndpointSlices
  getEndpointSlices: async (namespace: string, forceRefresh = false): Promise<EndpointSliceInfo[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/endpointslices`, {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getAllEndpointSlices: async (forceRefresh = false): Promise<EndpointSliceInfo[]> => {
    const { data } = await client.get('/cluster/endpointslices/all', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeEndpointSlice: async (namespace: string, name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/endpointslices/${name}/describe`)
    return data
  },

  deleteEndpointSlice: async (namespace: string, name: string): Promise<void> => {
    await client.delete(`/cluster/namespaces/${namespace}/endpointslices/${name}`)
  },

  // NetworkPolicies
  getNetworkPolicies: async (namespace: string, forceRefresh = false): Promise<NetworkPolicyInfo[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/networkpolicies`, {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getAllNetworkPolicies: async (forceRefresh = false): Promise<NetworkPolicyInfo[]> => {
    const { data } = await client.get('/cluster/networkpolicies/all', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeNetworkPolicy: async (namespace: string, name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/networkpolicies/${name}/describe`)
    return data
  },

  deleteNetworkPolicy: async (namespace: string, name: string): Promise<void> => {
    await client.delete(`/cluster/namespaces/${namespace}/networkpolicies/${name}`)
  },
}
