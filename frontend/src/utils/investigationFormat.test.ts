import { describe, expect, it } from 'vitest'
import i18next from 'i18next'
import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import { skipReason } from './investigationFormat'
import { formatTime } from './time'

async function trFor(lng: 'en' | 'ko') {
  const inst = i18next.createInstance()
  await inst.init({ lng, resources: { en: { translation: en }, ko: { translation: ko } }, interpolation: { escapeValue: false } })
  return (key: string, fallback: string, opts?: Record<string, unknown>) => inst.t(key, { defaultValue: fallback, ...opts })
}

describe('why an investigation was skipped', () => {
  it('words the investigation limit from its key and the number the server sent', async () => {
    const r = { skip_reason: 'investigation cap (100 new per webhook message)', skip_reason_key: 'investigation_cap', skip_reason_args: { limit: 100 } }
    const koText = skipReason(r, await trFor('ko'))
    expect(koText.label).toBe('조사 한도로 건너뜀')
    expect(koText.why).toBe('웹훅 한 통에서 새 조사는 100개까지 시작하고, 나머지는 알림함에 두었다가 Alertmanager가 다시 보낼 때 다시 시도함')
    const enText = skipReason(r, await trFor('en'))
    expect(enText.text).toBe('Skipped by the investigation limit — one webhook message starts at most 100 new investigations; the rest are kept in the inbox and tried again when Alertmanager sends them again')
  })

  it('words the earlier reasons too, a pause with the times in the viewer zone', async () => {
    const tr = await trFor('en')
    expect(skipReason({ skip_reason: 'hourly cap (6 per hour)', skip_reason_key: 'hourly_cap', skip_reason_args: { limit: 6 } }, tr).text)
      .toBe('Skipped by the hourly limit — at most 6 automatic investigations start in an hour')
    expect(skipReason({ skip_reason_key: 'daily_token_budget', skip_reason_args: { limit: 200000 } }, tr).label).toBe('Skipped by the daily token budget')
    const paused = skipReason({
      skip_reason_key: 'provider_paused', skip_reason_args: { kind: 'credit', at: '2026-10-13T11:55:00Z', until: '2026-10-13T12:25:00Z' },
    }, await trFor('ko'))
    expect(paused.text).toBe(`AI 제공자 일시 정지로 건너뜀 — AI 모델 제공자가 ${formatTime('2026-10-13T11:55:00Z')}에 거절했고(credit) ${formatTime('2026-10-13T12:25:00Z')}까지 조사를 시작하지 않음`)
  })

  it('shows a reason without a key as the server wrote it', async () => {
    expect(skipReason({ skip_reason: 'something else' }, await trFor('ko')).text).toBe('건너뜀: something else')
    expect(skipReason({ skip_reason: 'something else', skip_reason_key: '' }, await trFor('en'))).toEqual({
      label: 'Skipped: something else', why: '', text: 'Skipped: something else',
    })
  })
})
