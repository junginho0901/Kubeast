// Custom Resource API — CRDs (CustomResourceDefinitions) and the
// generic instance lookup that dispatches by group/version/plural.

import { client } from './client'
import type { CRDInfo, CustomResourceInstanceInfo, CustomResourceInstanceList } from './types'

// asked with with_unlisted=1, k8s-service answers the instances with the kinds it could not list; one from before
// answers the instances alone, read as the items with nothing named
export function instanceListFrom(data: CustomResourceInstanceList | CustomResourceInstanceInfo[]): CustomResourceInstanceList {
  return Array.isArray(data) ? { items: data } : data
}

export const customResourcesApi = {
  // CRDs
  getCRDs: async (forceRefresh = false): Promise<CRDInfo[]> => {
    const { data } = await client.get('/cluster/crds', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeCRD: async (name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/crds/${name}/describe`)
    return data
  },

  deleteCRD: async (name: string): Promise<void> => {
    await client.delete(`/cluster/crds/${name}`)
  },

  // Instances
  getAllCustomResourceInstances: async (forceRefresh = false): Promise<CustomResourceInstanceList> => {
    const { data } = await client.get('/cluster/custom-resources/all', {
      params: { force_refresh: forceRefresh, with_unlisted: 1 },
    })
    return instanceListFrom(data)
  },

  getCustomResourceInstances: async (group: string, version: string, plural: string): Promise<any[]> => {
    const { data } = await client.get(`/cluster/custom-resources/${group}/${version}/${plural}`)
    return data
  },

  describeCustomResourceInstance: async (group: string, version: string, plural: string, namespace: string, name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/custom-resources/${group}/${version}/${plural}/${namespace}/${name}/describe`)
    return data
  },

  deleteCustomResourceInstance: async (group: string, version: string, plural: string, namespace: string, name: string): Promise<void> => {
    await client.delete(`/cluster/custom-resources/${group}/${version}/${plural}/${namespace}/${name}`)
  },
}
