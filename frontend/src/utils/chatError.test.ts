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

  it('shows other errors as they came, and the server text for a key the catalog does not know', async () => {
    const t = await tFor('ko')
    expect(chatErrorText(t, 'OpenAI API 호출 실패: timeout')).toBe('OpenAI API 호출 실패: timeout')
    expect(chatErrorText(t, 'Some new refusal.', 'notInTheCatalog', { used: 1 })).toBe('Some new refusal.')
  })
})
