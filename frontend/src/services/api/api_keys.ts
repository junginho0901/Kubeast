// API keys — long-lived credentials a user issues for automation. The value
// is returned once, at creation; the client exchanges it for a short access
// token at POST /api/v1/auth/token (Authorization: Bearer kbk_…). A key is
// scoped to clusters (null = every cluster the user reaches) and capped at a
// role, never above the user's own rights.

import { client } from './client'

export interface APIKeysConfig {
  enabled: boolean
  max_days: number
}

export interface APIKey {
  id: string
  user_id: string
  name: string
  key_prefix: string
  cluster_ids: string[] | null
  role_ceiling: string
  expires_at: string
  last_used_at?: string
  last_used_ip?: string
  created_at: string
}

export interface CreateAPIKeyInput {
  name: string
  expires_in_days: number
  cluster_ids?: string[]
  role_ceiling?: string
}

export interface CreatedAPIKey extends APIKey {
  key: string
}

export const apiKeysApi = {
  getAPIKeysConfig: async (): Promise<APIKeysConfig> => {
    const { data } = await client.get('/auth/api-keys/config')
    return { enabled: !!data?.enabled, max_days: Number(data?.max_days) || 0 }
  },

  listMyAPIKeys: async (): Promise<APIKey[]> => {
    const { data } = await client.get('/auth/api-keys')
    return Array.isArray(data) ? data : []
  },

  createAPIKey: async (input: CreateAPIKeyInput): Promise<CreatedAPIKey> => {
    const { data } = await client.post('/auth/api-keys', input)
    return data
  },

  deleteAPIKey: async (id: string): Promise<void> => {
    await client.delete(`/auth/api-keys/${id}`)
  },

  adminListUserAPIKeys: async (userId: string): Promise<APIKey[]> => {
    const { data } = await client.get(`/auth/admin/users/${userId}/api-keys`)
    return Array.isArray(data) ? data : []
  },

  adminDeleteUserAPIKey: async (userId: string, id: string): Promise<void> => {
    await client.delete(`/auth/admin/users/${userId}/api-keys/${id}`)
  },
}
