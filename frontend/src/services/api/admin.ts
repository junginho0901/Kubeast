// Admin API — user / organization / role / audit-log management.
// All endpoints under /api/v1/auth/admin/* require admin role on the
// auth-service. End-user-facing auth (login/me/changePassword) lives
// in auth.ts.

import { client } from './client'
import type {
  AdminResetPasswordResponse,
  AuditLogFilter,
  AuditLogListResponse,
  Member,
  Organization,
  RoleWithDetails,
} from './types'

export const adminApi = {
  adminCreateOrganization: async (type: 'hq' | 'team', name: string): Promise<Organization> => {
    const { data } = await client.post('/auth/admin/organizations', { type, name })
    return data
  },

  adminDeleteOrganization: async (id: number): Promise<void> => {
    await client.delete(`/auth/admin/organizations/${id}`)
  },

  adminCreateUser: async (request: { name: string; email: string; password: string; role_id: number; hq?: string; team?: string }): Promise<Member> => {
    const { data } = await client.post('/auth/admin/users', request)
    return data
  },

  adminBulkUpdateRole: async (userIds: string[], roleId: number): Promise<Member[]> => {
    const { data } = await client.patch('/auth/admin/users/bulk-role', { user_ids: userIds, role_id: roleId })
    return data
  },

  adminBulkCreateUsers: async (users: Array<{ name: string; email: string; password: string; role_id: number; hq?: string; team?: string }>): Promise<{ created: Member[]; errors: Array<{ email: string; message: string }> }> => {
    const { data } = await client.post('/auth/admin/users/bulk', { users })
    return data
  },

  adminListUsers: async (params?: { limit?: number; offset?: number }): Promise<Member[]> => {
    const { data } = await client.get('/auth/admin/users', { params })
    if (!Array.isArray(data)) throw new Error('Invalid users response')
    return data as Member[]
  },

  adminUpdateUserRole: async (userId: string, roleId: number): Promise<Member> => {
    const { data } = await client.patch(`/auth/admin/users/${userId}`, { role_id: roleId })
    return data
  },

  adminUpdateUser: async (
    userId: string,
    payload: { name?: string; hq?: string; team?: string; role_id?: number },
  ): Promise<Member> => {
    const { data } = await client.patch(`/auth/admin/users/${userId}`, payload)
    return data
  },

  adminResetUserPassword: async (userId: string): Promise<AdminResetPasswordResponse> => {
    const { data } = await client.post(`/auth/admin/users/${userId}/reset-password`)
    return data
  },

  adminDeleteUser: async (userId: string): Promise<void> => {
    await client.delete(`/auth/admin/users/${userId}`)
  },

  // Per-cluster role grants (step 08/12). GET returns { clusterID: roleName }.
  // Grants apply on the user's NEXT login (token re-issue).
  getUserClusterRoles: async (userId: string): Promise<Record<string, string>> => {
    const { data } = await client.get(`/auth/admin/users/${userId}/cluster-roles`)
    return data && typeof data === 'object' ? data : {}
  },

  setUserClusterRole: async (userId: string, clusterId: string, role: string): Promise<void> => {
    await client.put(`/auth/admin/users/${userId}/cluster-roles/${clusterId}`, { role })
  },

  removeUserClusterRole: async (userId: string, clusterId: string): Promise<void> => {
    await client.delete(`/auth/admin/users/${userId}/cluster-roles/${clusterId}`)
  },

  // Roles
  listRoles: async (): Promise<RoleWithDetails[]> => {
    const { data } = await client.get('/auth/roles')
    return Array.isArray(data) ? data : []
  },

  listPermissions: async (): Promise<Array<{ category: string; permissions: Array<{ key: string; description: string }> }>> => {
    const { data } = await client.get('/auth/permissions')
    return Array.isArray(data) ? data : []
  },

  adminCreateRole: async (request: { name: string; description: string; permissions: string[] }): Promise<RoleWithDetails> => {
    const { data } = await client.post('/auth/admin/roles', request)
    return data
  },

  adminUpdateRole: async (id: number, request: { name: string; description: string; permissions: string[] }): Promise<RoleWithDetails> => {
    const { data } = await client.put(`/auth/admin/roles/${id}`, request)
    return data
  },

  adminDeleteRole: async (id: number): Promise<void> => {
    await client.delete(`/auth/admin/roles/${id}`)
  },

  // Audit Logs
  adminListAuditLogs: async (params?: AuditLogFilter): Promise<AuditLogListResponse> => {
    const { data } = await client.get('/auth/admin/audit-logs', { params })
    return {
      total: data?.total ?? 0,
      items: Array.isArray(data?.items) ? data.items : [],
    }
  },
}
