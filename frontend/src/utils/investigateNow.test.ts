import { describe, expect, it } from 'vitest'
import i18next from 'i18next'
import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import type { InvestigateNowState } from '@/services/api/alertInbox'
import { investigateErrorText, investigateNowView } from './investigateNow'
import { formatTime } from './time'

async function trFor(lng: 'en' | 'ko') {
  const inst = i18next.createInstance()
  await inst.init({ lng, resources: { en: { translation: en }, ko: { translation: ko } }, interpolation: { escapeValue: false } })
  return (key: string, fallback: string, opts?: Record<string, unknown>) => inst.t(key, { defaultValue: fallback, ...opts })
}

const state = (over: Partial<InvestigateNowState>): InvestigateNowState => ({
  permission: 'resource.alert.investigate', allowed: true, reason: '', until: null, automatic: true, budget: 200000, used: 60029, ...over,
})
const UNTIL = '2026-11-06T00:00:00Z'

describe('the alert window\'s Investigate now', () => {
  it('is hidden without the permission and while the alert\'s investigation is queued, running or done', async () => {
    const tr = await trFor('en')
    for (const reason of ['forbidden', 'investigating', 'investigated'] as const) {
      expect(investigateNowView(state({ allowed: false, reason }), tr), reason).toEqual({ show: false, enabled: false, note: '' })
    }
    expect(investigateNowView(undefined, tr), 'a server before the button').toEqual({ show: false, enabled: false, note: '' })
  })

  it('may be pressed with today\'s use of the budget from the server, or no note without a budget', async () => {
    expect(investigateNowView(state({}), await trFor('en'))).toEqual({
      show: true, enabled: true, note: `Asked-for investigations today: ${(60029).toLocaleString()} of ${(200000).toLocaleString()} tokens (UTC day)`,
    })
    expect(investigateNowView(state({}), await trFor('ko')).note).toBe(`오늘 요청한 조사: ${(200000).toLocaleString()} 토큰 중 ${(60029).toLocaleString()} 사용(UTC 날짜)`)
    expect(investigateNowView(state({ budget: 0, used: 0 }), await trFor('en'))).toEqual({ show: true, enabled: true, note: '' })
  })

  it('says why it is locked and when it works again, in the viewer\'s zone', async () => {
    const enTr = await trFor('en')
    const koTr = await trFor('ko')
    const spent = state({ allowed: false, reason: 'manual_budget', until: UNTIL, used: 210000 })
    expect(investigateNowView(spent, enTr)).toEqual({
      show: true, enabled: false,
      note: `Today's token budget for asked-for investigations (${(200000).toLocaleString()}) is used up: again from ${formatTime(UNTIL)}.`,
    })
    expect(investigateNowView(spent, koTr).note).toBe(`오늘 요청 조사의 토큰 한도(${(200000).toLocaleString()})를 다 썼습니다. ${formatTime(UNTIL)}부터 다시 됩니다.`)
    const paused = state({ allowed: false, reason: 'provider_paused', until: '2026-11-05T05:30:00Z' })
    expect(investigateNowView(paused, enTr).note).toBe(`The AI model provider refused an investigation: none starts until ${formatTime('2026-11-05T05:30:00Z')}.`)
    expect(investigateNowView(state({ allowed: false, reason: 'manual_off' }), koTr)).toEqual({
      show: true, enabled: false, note: '이 설치에서 꺼져 있습니다(features.alertInvestigation.manual).',
    })
  })

  it('words a refused press from the answer, the audit log, or as not started', async () => {
    const tr = await trFor('en')
    const refused = { response: { status: 429, data: { detail: { code: 'manual_budget', until: UNTIL, budget: 200000, used: 200000 } } } }
    expect(investigateErrorText(refused, tr)).toBe(`Today's token budget for asked-for investigations (${(200000).toLocaleString()}) is used up: again from ${formatTime(UNTIL)}.`)
    expect(investigateErrorText({ response: { status: 503, data: { detail: 'audit unavailable' } } }, tr)).toBe('Not started: the audit log cannot take the record right now.')
    expect(investigateErrorText({ response: { status: 403, data: { detail: { code: 'forbidden' } } } }, tr)).toBe('Not started.')
    expect(investigateErrorText(new Error('network'), await trFor('ko'))).toBe('시작하지 못했습니다.')
  })
})
