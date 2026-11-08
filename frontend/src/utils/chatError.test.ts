import { describe, expect, it } from 'vitest'
import i18next from 'i18next'
import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import { chatErrorText } from './chatError'

async function tFor(lng: 'en' | 'ko') {
  const inst = i18next.createInstance()
  await inst.init({ lng, resources: { en: { translation: en }, ko: { translation: ko } }, interpolation: { escapeValue: false } })
  return inst.t
}

describe('chatErrorText', () => {
  it('translates a budget refusal from its key and values', async () => {
    const ko_t = await tFor('ko')
    const text = chatErrorText(ko_t, 'This conversation has used 60,000 tokens…', 'budgetSession', { used: 60000, limit: 50000 })
    expect(text).toBe(`이 대화는 토큰 ${(60000).toLocaleString()}개를 써서 대화 예산 ${(50000).toLocaleString()}개를 넘었습니다. 이어서 하려면 새 대화를 시작하세요.`)
    const en_t = await tFor('en')
    expect(chatErrorText(en_t, 'x', 'budgetUserDaily', { used: 250000, limit: 200000 })).toContain(`over the daily budget of ${(200000).toLocaleString()}`)
  })

  it('says a conversation that is gone in the screen language', async () => {
    expect(chatErrorText(await tFor('ko'), 'Session not found', 'sessionNotFound')).toBe('이 대화는 더 이상 없습니다. 새 대화를 시작하세요.')
    expect(chatErrorText(await tFor('en'), 'Session not found', 'sessionNotFound')).toBe('This conversation no longer exists. Start a new one.')
  })

  it('names the provider of a failed model call in the screen language, the same wording on every provider', async () => {
    const args = { provider: 'Claude subscription', detail: 'Claude Code failed: timeout' }
    expect(chatErrorText(await tFor('ko'), 'AI model call failed (Claude subscription): Claude Code failed: timeout', 'modelCall', args))
      .toBe('AI 모델을 호출하지 못했습니다 (Claude subscription): Claude Code failed: timeout')
    expect(chatErrorText(await tFor('en'), 'x', 'modelCall', { provider: 'Anthropic', detail: '529 overloaded' }))
      .toBe('AI model call failed (Anthropic): 529 overloaded')
  })

  it('says what kind of refusal the provider gave and who acts on it', async () => {
    const ko_t = await tFor('ko')
    const args = { provider: 'OpenAI', detail: '429 insufficient_quota' }
    expect(chatErrorText(ko_t, 'x', 'modelCredit', args)).toBe(
      'AI 모델을 호출하지 못했습니다 (OpenAI): 공급자 계정의 크레딧이나 사용 한도가 다 떨어졌습니다. 관리자가 Admin → AI Models에서 확인하거나 다른 모델을 고르세요. (429 insufficient_quota)')
    expect(chatErrorText(ko_t, 'x', 'modelUsageWindow', { provider: 'Claude subscription', detail: 'rate_limit', retry_at: '2026-10-19T12:00:00Z' }))
      .toContain('2026-10-19T12:00:00Z(UTC)에 풀립니다')
    const en_t = await tFor('en')
    for (const [key, words] of [['modelRateLimit', 'Try again in a minute'], ['modelAuth', 'refused the key or token'], ['modelUnavailable', 'overloaded or did not answer']]) {
      expect(chatErrorText(en_t, 'x', key, args)).toContain(words)
    }
  })

  it('says a refused model address sent nothing, without the address, and who looks at it', async () => {
    const args = { provider: 'OpenAI-compatible', detail: "the model's address is not allowed, so nothing was sent" }
    expect(chatErrorText(await tFor('ko'), 'x', 'modelAddress', args)).toBe(
      'AI 모델을 호출하지 못했습니다 (OpenAI-compatible): 모델 주소가 허용되지 않아 아무것도 보내지 않았습니다. 관리자가 Admin → AI Models에서 이 모델의 연결 테스트로 이유를 확인하세요.')
    expect(chatErrorText(await tFor('en'), 'x', 'modelAddress', args)).toBe(
      "AI model call failed (OpenAI-compatible): the model's address is not allowed, so nothing was sent. An administrator runs Test on this model in Admin → AI Models to see why.")
  })

  it('says in the screen language how a stream ended without an answer', async () => {
    const ko_t = await tFor('ko')
    expect(chatErrorText(ko_t, 'x', 'streamHttp', { status: 503, detail: 'audit unavailable' })).toBe('채팅 요청이 실패했습니다 (HTTP 503): audit unavailable')
    expect(chatErrorText(ko_t, 'x', 'streamHttpStatus', { status: 502 })).toBe('채팅 요청이 실패했습니다 (HTTP 502).')
    expect(chatErrorText(ko_t, 'x', 'streamCut')).toBe('답변이 끝나기 전에 연결이 끊겼습니다. 위 내용은 일부일 수 있습니다. 전체 답변이 필요하면 다시 질문하세요.')
    expect(chatErrorText(ko_t, 'x', 'streamEmpty')).toBe('답변 없이 연결이 끊겼습니다. 다시 질문하세요.')
    const en_t = await tFor('en')
    expect(chatErrorText(en_t, 'x', 'streamHttp', { status: 503, detail: 'audit unavailable' })).toBe('The chat request failed (HTTP 503): audit unavailable')
    expect(chatErrorText(en_t, 'x', 'streamHttpStatus', { status: 502 })).toBe('The chat request failed (HTTP 502).')
    expect(chatErrorText(en_t, 'x', 'streamCut')).toContain('before the answer finished')
    expect(chatErrorText(en_t, 'x', 'streamEmpty')).toContain('without an answer')
  })

  it('shows other errors as they came, and the server text for a key the catalog does not know', async () => {
    const t = await tFor('ko')
    expect(chatErrorText(t, 'upstream timeout')).toBe('upstream timeout')
    expect(chatErrorText(t, 'Some new refusal.', 'notInTheCatalog', { used: 1 })).toBe('Some new refusal.')
  })
})
