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

  it('shows other errors as they came, and the server text for a key the catalog does not know', async () => {
    const t = await tFor('ko')
    expect(chatErrorText(t, 'upstream timeout')).toBe('upstream timeout')
    expect(chatErrorText(t, 'Some new refusal.', 'notInTheCatalog', { used: 1 })).toBe('Some new refusal.')
  })
})
