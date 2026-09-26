// Auth API — login / logout / register / me / change password /
// list organizations. Calls land on /api/v1/auth/* which the gateway
// routes to the auth-service (Go). Admin-side user/role/audit
// endpoints live in admin.ts.

import { client } from './client'
import type { AuthResponse, Member, OIDCLoginConfig, Organization } from './types'

export const authApi = {
  // Single sign-on is a server-side redirect flow: the page only needs to know
  // whether to show the button. GET /auth/oidc/login is a plain link.
  oidcConfig: async (): Promise<OIDCLoginConfig> => {
    const { data } = await client.get('/auth/oidc/config')
    return data
  },

  register: async (request: { name: string; email: string; password: string; team?: string }): Promise<Member> => {
    const { data } = await client.post('/auth/register', request)
    return data
  },

  login: async (request: { email: string; password: string }): Promise<AuthResponse> => {
    const { data } = await client.post('/auth/login', request)
    // auth-service 는 user 필드로 내려줌. 기존 session-service(member) 호환 유지.
    if (data?.user && !data?.member) {
      data.member = data.user
    }
    return data
  },

  logout: async (): Promise<void> => {
    await client.post('/auth/logout')
  },

  listOrganizations: async (type: 'team'): Promise<Organization[]> => {
    const { data } = await client.get('/auth/organizations', { params: { type } })
    return Array.isArray(data) ? data : []
  },

  me: async (): Promise<Member> => {
    const { data } = await client.get('/auth/me')
    return data
  },

  changePassword: async (request: { current_password: string; new_password: string }): Promise<Member> => {
    const { data } = await client.post('/auth/change-password', request)
    return data
  },
}
