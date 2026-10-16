import { describe, expect, it } from 'vitest'
import i18next from 'i18next'
import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import { turnUsageText } from './turnUsage'

async function tFor(lng: 'en' | 'ko') {
  const inst = i18next.createInstance()
  await inst.init({ lng, resources: { en: { translation: en }, ko: { translation: ko } }, interpolation: { escapeValue: false } })
  return inst.t
}

const n = (v: number) => v.toLocaleString()

describe('turnUsageText', () => {
  it('reads prompt, completion and the cached share, with the calls and model in the tooltip', async () => {
    const usage = { prompt_tokens: 31652, completion_tokens: 860, cached_tokens: 30015, model_calls: 2, model: 'granite4.1:8b' }
    const ko_t = await tFor('ko')
    expect(turnUsageText(ko_t, usage)).toEqual({
      text: `입력 ${n(31652)} · 출력 ${n(860)} 토큰 · 캐시 95%`,
      title: '모델 호출 2회 · granite4.1:8b',
    })
    const en_t = await tFor('en')
    expect(turnUsageText(en_t, usage)?.text).toBe(`In ${n(31652)} · out ${n(860)} tokens · 95% cached`)
  })

  it('leaves out the cached share without prompt tokens or a cached count, and shows nothing without usage', async () => {
    const t = await tFor('en')
    expect(turnUsageText(t, { prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0 })?.text).toBe('In 0 · out 0 tokens')
    expect(turnUsageText(t, { prompt_tokens: 100, completion_tokens: 5 })?.text).toBe('In 100 · out 5 tokens')
    expect(turnUsageText(t, null)).toBeNull()
    expect(turnUsageText(t, { model: 'm' } as never)).toBeNull()
  })
})
