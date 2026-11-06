import { describe, expect, it } from 'vitest'
import i18n from 'i18next'

import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import { bulkRoleFailures, bulkRoleFailureText, readBulkRoleAnswer } from './bulkRole'

async function tFor(lang: 'en' | 'ko') {
  const inst = i18n.createInstance()
  await inst.init({ lng: lang, resources: { en: { translation: en }, ko: { translation: ko } }, interpolation: { escapeValue: false } })
  return inst.t.bind(inst)
}

const member = (id: string) => ({ id, name: id, role: null, created_at: '', updated_at: '' })

describe('the answer of a bulk role change', () => {
  it('reads everyone changed from the list the route has always answered', () => {
    expect(readBulkRoleAnswer([member('a'), member('b')])).toEqual({ updated: [member('a'), member('b')], failed: [] })
  })

  it('reads the accounts it could not change next to the ones it did', () => {
    const failed = [{ user_id: 'b', email: 'b@example.com', reason: 'failed' as const }]
    expect(readBulkRoleAnswer({ updated: [member('a')], failed })).toEqual({ updated: [member('a')], failed })
  })

  it('reads a refusal the server made of the whole call as having no list', () => {
    expect(bulkRoleFailures({ response: { data: { detail: 'permission ceiling' } } })).toEqual([])
    expect(bulkRoleFailures(new Error('network'))).toEqual([])
  })

  it('reads the list from a call that changed nobody', () => {
    const failed = [{ user_id: 'b', email: 'b@example.com', reason: 'failed' as const }]
    expect(bulkRoleFailures({ response: { data: { detail: 'x', failed } } })).toEqual(failed)
  })
})

describe('what the screen says of it', () => {
  const failed = [
    { user_id: 'r1', email: 'reader@example.com', reason: 'failed' as const },
    { user_id: 'gone-1', reason: 'not_found' as const },
    { user_id: 'me', email: 'me@example.com', reason: 'self' as const },
  ]

  it('names how many changed, every account that did not and why', async () => {
    const text = bulkRoleFailureText(await tFor('en'), 4, failed)
    expect(text).toBe('1 of 4 accounts changed. Not changed: reader@example.com (the change failed, the audit log says why), gone-1 (no such account), me@example.com (your own account)')
  })

  it('says the same in Korean', async () => {
    const text = bulkRoleFailureText(await tFor('ko'), 4, failed)
    expect(text).toBe('계정 4개 중 1개를 바꿨습니다. 바꾸지 못한 계정: reader@example.com (변경 실패, 까닭은 감사 로그에 있습니다), gone-1 (없는 계정), me@example.com (본인 계정)')
  })
})
