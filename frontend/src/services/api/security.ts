// Security API — RBAC objects: ServiceAccounts / Roles / RoleBindings
// / ClusterRoles / ClusterRoleBindings. PodSecurityPolicies are not
// served by the backend any more (deprecated upstream).

import { client } from './client'
import type {
  ClusterRoleBindingInfo,
  ClusterRoleInfo,
  RoleBindingInfo,
  RoleInfo,
  ServiceAccountInfo,
} from './types'

export const securityApi = {
  // Whether the cluster lets the signed-in user do verb on resource
  // (SelfSubjectAccessReview — kubectl auth can-i). Empty namespace = every namespace.
  canI: async (q: { verb: string; group: string; resource: string; namespace?: string }): Promise<boolean> => {
    const { data } = await client.get('/cluster/can-i', { params: { ...q, namespace: q.namespace || undefined } })
    return !!data?.allowed
  },

  // ServiceAccounts
  getServiceAccounts: async (namespace: string, forceRefresh = false): Promise<ServiceAccountInfo[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/serviceaccounts`, {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getAllServiceAccounts: async (forceRefresh = false): Promise<ServiceAccountInfo[]> => {
    const { data } = await client.get('/cluster/serviceaccounts/all', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeServiceAccount: async (namespace: string, name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/serviceaccounts/${name}/describe`)
    return data
  },

  deleteServiceAccount: async (namespace: string, name: string): Promise<void> => {
    await client.delete(`/cluster/namespaces/${namespace}/serviceaccounts/${name}`)
  },

  // Roles
  getRoles: async (namespace: string, forceRefresh = false): Promise<RoleInfo[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/roles`, {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getAllRoles: async (forceRefresh = false): Promise<RoleInfo[]> => {
    const { data } = await client.get('/cluster/roles/all', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeRole: async (namespace: string, name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/roles/${name}/describe`)
    return data
  },

  deleteRole: async (namespace: string, name: string): Promise<void> => {
    await client.delete(`/cluster/namespaces/${namespace}/roles/${name}`)
  },

  // RoleBindings
  getRoleBindings: async (namespace: string, forceRefresh = false): Promise<RoleBindingInfo[]> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/rolebindings`, {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  getAllRoleBindings: async (forceRefresh = false): Promise<RoleBindingInfo[]> => {
    const { data } = await client.get('/cluster/rolebindings/all', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeRoleBinding: async (namespace: string, name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/namespaces/${namespace}/rolebindings/${name}/describe`)
    return data
  },

  deleteRoleBinding: async (namespace: string, name: string): Promise<void> => {
    await client.delete(`/cluster/namespaces/${namespace}/rolebindings/${name}`)
  },

  // ClusterRoles
  getClusterRoles: async (forceRefresh = false): Promise<ClusterRoleInfo[]> => {
    const { data } = await client.get('/cluster/clusterroles', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeClusterRole: async (name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/clusterroles/${name}/describe`)
    return data
  },

  deleteClusterRole: async (name: string): Promise<void> => {
    await client.delete(`/cluster/clusterroles/${name}`)
  },

  // ClusterRoleBindings
  getClusterRoleBindings: async (forceRefresh = false): Promise<ClusterRoleBindingInfo[]> => {
    const { data } = await client.get('/cluster/clusterrolebindings', {
      params: { force_refresh: forceRefresh },
    })
    return data
  },

  describeClusterRoleBinding: async (name: string): Promise<any> => {
    const { data } = await client.get(`/cluster/clusterrolebindings/${name}/describe`)
    return data
  },

  deleteClusterRoleBinding: async (name: string): Promise<void> => {
    await client.delete(`/cluster/clusterrolebindings/${name}`)
  },
}
