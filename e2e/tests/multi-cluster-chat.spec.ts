import { test, expect, type APIRequestContext } from '@playwright/test'

// Chat history is scoped per cluster (step 13): sessions.cluster_id, written +
// filtered by session-service. A session created while one cluster is selected
// must not appear when another cluster is selected.

const EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const PASSWORD = process.env.E2E_USER_PASSWORD || ''

async function login(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email: EMAIL, password: PASSWORD } })
  expect(res.ok()).toBeTruthy()
  return (await res.json()).access_token
}

test.describe('multi-cluster chat history (step 13)', () => {
  test('a session created in one cluster is not listed in another', async ({ request }) => {
    const auth = { Authorization: `Bearer ${await login(request)}` }
    let sessionId = ''
    try {
      // create a session while 'default' is the active cluster
      const created = await request.post('/api/v1/sessions?cluster=default', {
        headers: auth,
        data: { title: `e2e-chat-${Date.now()}` },
      })
      expect(created.status()).toBe(200)
      sessionId = (await created.json()).id
      expect(sessionId).toBeTruthy()

      // listed under 'default'
      const inDefault = await request.get('/api/v1/sessions?cluster=default', { headers: auth })
      const defaultIds = ((await inDefault.json()) as { id: string }[]).map((s) => s.id)
      expect(defaultIds).toContain(sessionId)

      // NOT listed under 'self'
      const inSelf = await request.get('/api/v1/sessions?cluster=self', { headers: auth })
      const selfIds = ((await inSelf.json()) as { id: string }[]).map((s) => s.id)
      expect(selfIds, 'session must not leak across clusters').not.toContain(sessionId)
    } finally {
      if (sessionId) {
        await request.delete(`/api/v1/sessions/${sessionId}`, { headers: auth, failOnStatusCode: false })
      }
    }
  })
})
