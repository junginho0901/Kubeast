import { test, expect, type APIRequestContext } from '@playwright/test'
import { sessionToken } from './session-token'

// Chat history is scoped per cluster (step 13): sessions.cluster_id, written +
// filtered by session-service. A session created while one cluster is selected
// must not appear when another cluster is selected.

const EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const PASSWORD = process.env.E2E_USER_PASSWORD || ''

async function login(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email: EMAIL, password: PASSWORD } })
  expect(res.ok()).toBeTruthy()
  return sessionToken(res)
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
      sessionId = withUndo((await created.json()).id, (i) => request.delete(`/api/v1/sessions/${i}`, { headers: auth, failOnStatusCode: false }))
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

// After a test that did not pass, the undos it registered with withUndo run as well: a test that times out has its
// request context and browser ended before its own finally runs, if it runs at all. Each undo is safe to run twice.
const undos: (() => unknown)[] = []
function withUndo<T>(value: T, undo: (value: T) => unknown): T {
  undos.push(() => undo(value))
  return value
}
test.afterEach(async ({}, testInfo) => {
  const registered = undos.splice(0).reverse()
  if (testInfo.status === 'passed' || testInfo.status === 'skipped') return
  for (const undo of registered) await (async () => undo())().catch(() => undefined)
})
