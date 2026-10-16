import { test, expect, type APIRequestContext } from '@playwright/test'

// Chat history summary (ai.chat.summary.enabled): the last AI_CHAT_HISTORY_MESSAGES (dev: 10) user/assistant
// messages go to the model verbatim and the ones before them are folded into one running summary, rebuilt only
// when new messages fall out of the window. The summary itself is not exposed, so the spec reads the audit rows
// the summarizer writes (ai.chat.summarize) and the turn's ai.chat.complete.

const EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const PASSWORD = process.env.E2E_USER_PASSWORD || ''
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })
const stamp = () => Date.now().toString(36)

async function login(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email: EMAIL, password: PASSWORD } })
  expect(res.ok(), `login: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

async function chatTurn(request: APIRequestContext, token: string, sessionId: string, message: string): Promise<string> {
  const res = await request.post(`/api/v1/ai/sessions/${sessionId}/chat`, {
    headers: { ...bearer(token), Accept: 'text/event-stream', 'X-Cluster-Name': 'self' },
    data: { message },
    timeout: 180_000,
  })
  expect(res.ok(), `chat: ${res.status()}`).toBeTruthy()
  const body = await res.text()
  expect(body).toContain('[DONE]')
  return body
    .split('\n')
    .filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
    .map((l) => {
      try {
        return JSON.parse(l.slice(6))
      } catch {
        return {}
      }
    })
    .map((d) => (typeof d.content === 'string' ? d.content : ''))
    .join('')
}

async function auditRows(request: APIRequestContext, token: string, action: string, sessionId: string) {
  const res = await request.get('/api/v1/auth/admin/audit-logs', { headers: bearer(token), params: { action, limit: 20 } })
  expect(res.ok()).toBeTruthy()
  const { items } = (await res.json()) as { items: Array<Record<string, any>> }
  return items
    .map((e) => ({ result: e.Result ?? e.result, after: e.After ?? e.after ?? {} }))
    .filter((e) => e.after.session_id === sessionId)
}

test.describe('AI chat history summary', () => {
  test.setTimeout(400_000)

  test('messages beyond the window are folded into one audited summary that grows incrementally', async ({ request }) => {
    const token = await login(request)
    const codename = `TANGERINE-${stamp()}`
    const created = await request.post('/api/v1/sessions', { headers: bearer(token), data: { title: `e2e-summary-${stamp()}` } })
    expect(created.ok()).toBeTruthy()
    const sessionId = (await created.json()).id as string
    try {
      // Twelve earlier messages, the fact to remember in the very first one.
      const seeded: Array<{ role: string; content: string }> = []
      for (let i = 1; i <= 6; i++) {
        seeded.push({ role: 'user', content: i === 1 ? `우리 팀 코드명은 ${codename}이야. 기억해 둬. kubeast 네임스페이스 파드 상태 알려줘` : `질문 ${i}: default 네임스페이스에 디플로이먼트가 몇 개야?` })
        seeded.push({ role: 'assistant', content: i === 1 ? `알겠습니다, 코드명 ${codename}을 기억하겠습니다. kubeast 네임스페이스에는 파드 10개가 Running입니다.` : `답 ${i}: default 네임스페이스에는 디플로이먼트가 3개 있습니다.` })
      }
      const saved = await request.post(`/api/v1/sessions/${sessionId}/messages`, { headers: bearer(token), data: { messages: seeded } })
      expect(saved.ok(), `seed: ${saved.status()}`).toBeTruthy()

      // Turn 1: 12 seeded + this user message = 13 user/assistant messages → window 10 → 3 are summarised.
      const answer1 = await chatTurn(request, token, sessionId, '내 팀 코드명이 뭐였지? 한 줄로만 답해.')
      console.log(`turn 1 answer (model-dependent, not asserted): ${answer1.slice(0, 160).replace(/\n/g, ' ')}`)
      let rows = await auditRows(request, token, 'ai.chat.summarize', sessionId)
      expect(rows.length).toBe(1)
      expect(rows[0].result).toBe('success')
      expect(rows[0].after.messages_summarized).toBe(3)
      expect(rows[0].after.messages_total).toBe(3)
      expect(rows[0].after.upto_message_id).toBeGreaterThan(0)
      expect(rows[0].after.summary_chars).toBeGreaterThan(20)
      expect(rows[0].after.summary_chars).toBeLessThanOrEqual(1500)
      expect(rows[0].after.model).toBeTruthy()
      // The turn's own record includes the summarizer call.
      const complete = await auditRows(request, token, 'ai.chat.complete', sessionId)
      expect(complete.length).toBeGreaterThanOrEqual(1)
      expect(complete[0].after.model_calls).toBeGreaterThanOrEqual(2)

      // Turn 2: the assistant reply and this message push two more out of the window → one more row covering 2 (total 5).
      await chatTurn(request, token, sessionId, 'ok라고만 답해.')
      rows = await auditRows(request, token, 'ai.chat.summarize', sessionId)
      expect(rows.length).toBe(2)
      const latest = (list: typeof rows) => list.reduce((a, b) => (a.after.upto_message_id > b.after.upto_message_id ? a : b))
      expect(latest(rows).after.messages_summarized).toBe(2)
      expect(latest(rows).after.messages_total).toBe(5)

      // Turn 3: the summary has to survive the turn's own end-of-turn context write — only the 2 newly dropped
      // messages are folded (a summary lost between turns would fold 4 here), total 7.
      await chatTurn(request, token, sessionId, 'ok라고만 답해.')
      rows = await auditRows(request, token, 'ai.chat.summarize', sessionId)
      expect(rows.length).toBe(3)
      expect(latest(rows).after.messages_summarized).toBe(2)
      expect(latest(rows).after.messages_total).toBe(7)
    } finally {
      await request.delete(`/api/v1/sessions/${sessionId}`, { headers: bearer(token) })
    }
  })

  test('a short conversation is sent whole: no summary row', async ({ request }) => {
    const token = await login(request)
    const created = await request.post('/api/v1/sessions', { headers: bearer(token), data: { title: `e2e-nosummary-${stamp()}` } })
    expect(created.ok()).toBeTruthy()
    const sessionId = (await created.json()).id as string
    try {
      const saved = await request.post(`/api/v1/sessions/${sessionId}/messages`, {
        headers: bearer(token),
        data: { messages: [{ role: 'user', content: '안녕' }, { role: 'assistant', content: '안녕하세요.' }] },
      })
      expect(saved.ok()).toBeTruthy()
      await chatTurn(request, token, sessionId, 'ok라고만 답해.')
      expect(await auditRows(request, token, 'ai.chat.summarize', sessionId)).toEqual([])
      const complete = await auditRows(request, token, 'ai.chat.complete', sessionId)
      expect(complete.length).toBe(1)
    } finally {
      await request.delete(`/api/v1/sessions/${sessionId}`, { headers: bearer(token) })
    }
  })
})
