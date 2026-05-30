// Configuration API — cluster-wide config-ish resources that don't
// fit into workloads / network / storage / security:
// PriorityClass / RuntimeClass / Lease / ResourceQuota / LimitRange /
// MutatingWebhookConfiguration / ValidatingWebhookConfiguration /
// ConfigMap / Secret.

import { client } from './client'
import type {
  ConfigMapInfo,
  LeaseInfo,
  LimitRangeInfo,
  PriorityClassInfo,
  ResourceQuotaInfo,
  RuntimeClassInfo,
  SecretInfo,
  WebhookConfigInfo,
} from './types'

export const configurationApi = {
  // PriorityClass
  getPriorityClasses: async (forceRefresh = false): Promise<PriorityClassInfo[]> => {
    const { data } = await client.get('/cluster/priorityclasses', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describePriorityClass: async (name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/priorityclasses/${name}/describe`)
    return data
  },

  deletePriorityClass: async (name: string): Promise<void> => {
    await client.delete(`/cluster/priorityclasses/${name}`)
  },

  // RuntimeClass
  getRuntimeClasses: async (forceRefresh = false): Promise<RuntimeClassInfo[]> => {
    const { data } = await client.get('/cluster/runtimeclasses', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeRuntimeClass: async (name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/runtimeclasses/${name}/describe`)
    return data
  },

  deleteRuntimeClass: async (name: string): Promise<void> => {
    await client.delete(`/cluster/runtimeclasses/${name}`)
  },

  // Lease
  getAllLeases: async (forceRefresh = false): Promise<LeaseInfo[]> => {
    const { data } = await client.get('/cluster/leases/all', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getLeases: async (namespace: string, forceRefresh = false): Promise<LeaseInfo[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/leases`, {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeLease: async (namespace: string, name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/leases/${name}/describe`)
    return data
  },

  deleteLease: async (namespace: string, name: string): Promise<void> => {
    await client.delete(`/cluster/namespaces/${namespace}/leases/${name}`)
  },

  // ResourceQuotas
  getAllResourceQuotas: async (forceRefresh = false): Promise<ResourceQuotaInfo[]> => {
    const { data } = await client.get('/cluster/resourcequotas/all', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getResourceQuotas: async (namespace: string, forceRefresh = false): Promise<ResourceQuotaInfo[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/resourcequotas`, {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeResourceQuota: async (namespace: string, name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/resourcequotas/${name}/describe`)
    return data
  },

  deleteResourceQuota: async (namespace: string, name: string): Promise<void> => {
    await client.delete(`/cluster/namespaces/${namespace}/resourcequotas/${name}`)
  },

  // LimitRanges
  getAllLimitRanges: async (forceRefresh = false): Promise<LimitRangeInfo[]> => {
    const { data } = await client.get('/cluster/limitranges/all', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getLimitRanges: async (namespace: string, forceRefresh = false): Promise<LimitRangeInfo[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/limitranges`, {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeLimitRange: async (namespace: string, name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/limitranges/${name}/describe`)
    return data
  },

  listPodsViolatingLimitRange: async (namespace: string, name: string): Promise<Array<{ pod: string; namespace: string; container: string; field: string; actual: string; limit: string }>> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/limitranges/${name}/violations`)
    return data
  },

  deleteLimitRange: async (namespace: string, name: string): Promise<void> => {
    await client.delete(`/cluster/namespaces/${namespace}/limitranges/${name}`)
  },

  // MutatingWebhookConfigurations
  getMutatingWebhookConfigurations: async (forceRefresh = false): Promise<WebhookConfigInfo[]> => {
    const { data } = await client.get('/cluster/mutatingwebhookconfigurations', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeMutatingWebhookConfiguration: async (name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/mutatingwebhookconfigurations/${name}/describe`)
    return data
  },

  deleteMutatingWebhookConfiguration: async (name: string): Promise<void> => {
    await client.delete(`/cluster/mutatingwebhookconfigurations/${name}`)
  },

  // ValidatingWebhookConfigurations
  getValidatingWebhookConfigurations: async (forceRefresh = false): Promise<WebhookConfigInfo[]> => {
    const { data } = await client.get('/cluster/validatingwebhookconfigurations', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeValidatingWebhookConfiguration: async (name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/validatingwebhookconfigurations/${name}/describe`)
    return data
  },

  deleteValidatingWebhookConfiguration: async (name: string): Promise<void> => {
    await client.delete(`/cluster/validatingwebhookconfigurations/${name}`)
  },

  // ConfigMaps
  getConfigMaps: async (namespace: string, forceRefresh = false): Promise<ConfigMapInfo[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/configmaps`, {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getAllConfigMaps: async (forceRefresh = false): Promise<ConfigMapInfo[]> => {
    const { data } = await client.get('/cluster/configmaps/all', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeConfigMap: async (namespace: string, name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/configmaps/${name}/describe`)
    return data
  },

  deleteConfigMap: async (namespace: string, name: string): Promise<void> => {
    await client.delete(`/cluster/namespaces/${namespace}/configmaps/${name}`)
  },

  // Secrets
  getSecrets: async (namespace: string, forceRefresh = false): Promise<SecretInfo[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/secrets`, {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getAllSecrets: async (forceRefresh = false): Promise<SecretInfo[]> => {
    const { data } = await client.get('/cluster/secrets/all', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeSecret: async (namespace: string, name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/secrets/${name}/describe`)
    return data
  },

  getSecretYaml: async (namespace: string, name: string): Promise<{ yaml: string }> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/secrets/${name}/yaml`)
    return typeof data === 'string' ? { yaml: data } : data
  },

  deleteSecret: async (namespace: string, name: string): Promise<void> => {
    await client.delete(`/cluster/namespaces/${namespace}/secrets/${name}`)
  },
}
