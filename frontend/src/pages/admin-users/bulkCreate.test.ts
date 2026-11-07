import { describe, expect, it } from 'vitest'
import i18n from 'i18next'

import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import { bulkCreateFailureRows, bulkCreateFailures, bulkCreateSummary, parseBulkCsv, readBulkCreateAnswer } from './bulkCreate'

async function tFor(lang: 'en' | 'ko') {
  const inst = i18n.createInstance()
  await inst.init({ lng: lang, resources: { en: { translation: en }, ko: { translation: ko } }, interpolation: { escapeValue: false } })
  return inst.t.bind(inst)
}

const member = (id: string) => ({ id, name: id, role: null, created_at: '', updated_at: '' })

describe('the answer of a bulk creation', () => {
  it('reads the accounts it made and the ones it left out', () => {
    const failed = [{ email: 'b@example.com', reason: 'exists' as const }]
    expect(readBulkCreateAnswer({ created: [member('a')], failed })).toEqual({ created: [member('a')], failed })
  })

  it('reads an answer with no lists as nobody and nothing', () => {
    expect(readBulkCreateAnswer({ created: null, failed: null })).toEqual({ created: [], failed: [] })
  })

  it('reads the accounts from a call a failed write left empty', () => {
    const failed = [{ email: 'b@example.com', reason: 'failed' as const }]
    expect(bulkCreateFailures({ response: { data: { detail: 'x', created: [], failed } } })).toEqual(failed)
  })

  it('reads a refusal of the whole call as having no list', () => {
    expect(bulkCreateFailures({ response: { data: { detail: 'Permission denied' } } })).toEqual([])
    expect(bulkCreateFailures(new Error('network'))).toEqual([])
  })
})

describe('what the screen says of it', () => {
  const failed = [
    { email: 'a@example.com', reason: 'missing_fields' as const },
    { email: 'b@example.com', reason: 'password' as const, detail: 'password must be at least 12 characters' },
    { email: 'c@example.com', reason: 'role' as const },
    { email: 'd@example.com', reason: 'ceiling' as const, detail: 'admin.users.delete' },
    { email: 'e@example.com', reason: 'team' as const, detail: 'ghost' },
    { email: 'f@example.com', reason: 'exists' as const },
    { email: 'g@example.com', reason: 'failed' as const },
    { email: '', reason: 'missing_fields' as const },
  ]

  it('names every account it left out and why', async () => {
    expect(bulkCreateFailureRows(await tFor('en'), failed)).toEqual([
      'a@example.com: name, email and password are required',
      'b@example.com: the password does not meet the policy: password must be at least 12 characters',
      'c@example.com: no such role',
      'd@example.com: the role gives permissions you do not hold: admin.users.delete',
      'e@example.com: no such team: ghost',
      'f@example.com: this email already has an account',
      'g@example.com: the creation failed, the audit log says why',
      '-: name, email and password are required',
    ])
  })

  it('says the same in Korean', async () => {
    expect(bulkCreateFailureRows(await tFor('ko'), failed)).toEqual([
      'a@example.com: 이름, 이메일, 비밀번호가 필요합니다',
      'b@example.com: 비밀번호가 정책에 맞지 않습니다: password must be at least 12 characters',
      'c@example.com: 없는 역할입니다',
      'd@example.com: 역할에 내가 갖지 않은 권한이 있습니다: admin.users.delete',
      'e@example.com: 없는 팀입니다: ghost',
      'f@example.com: 이미 계정이 있는 이메일입니다',
      'g@example.com: 만들지 못했습니다, 까닭은 감사 로그에 있습니다',
      '-: 이름, 이메일, 비밀번호가 필요합니다',
    ])
  })

  it('counts them out of what was sent', async () => {
    expect(bulkCreateSummary(await tFor('en'), 8, 2)).toBe('Not created: 2 of 8 accounts')
    expect(bulkCreateSummary(await tFor('ko'), 8, 2)).toBe('만들지 못한 계정: 8개 중 2개')
  })
})

describe('the rows of the CSV', () => {
  const roles = [{ id: 1, name: 'Member' }, { id: 2, name: 'Admin' }, { id: 3, name: 'read' }]
  const csv = (...rows: string[]) => ['﻿# Available Team: web', '# role (account level): Admin, Member', 'name,email,password,role,team', ...rows, ''].join('\n')

  it('sends the rows it can read, with their role and team', () => {
    expect(parseBulkCsv(csv('Ann,ann@example.com,fake-pass-1,Admin,web', ' Bob , bob@example.com ,fake-pass-2,Member,'), roles)).toEqual({
      users: [
        { name: 'Ann', email: 'ann@example.com', password: 'fake-pass-1', role_id: 2, team: 'web' },
        { name: 'Bob', email: 'bob@example.com', password: 'fake-pass-2', role_id: 1, team: undefined },
      ],
      failed: [],
    })
  })

  it('keeps the role the template leaves out as it was', () => {
    expect(parseBulkCsv(csv('Ann,ann@example.com,fake-pass-1'), roles).users[0].role_id).toBe(3)
  })

  it('names a row it cannot send instead of dropping it, without the password', () => {
    const parsed = parseBulkCsv(csv(
      'Ann,ann@example.com,fake-pass-1,Member',
      ',noname@example.com,fake-pass-2,Member',
      'Nomail,,fake-pass-3,Member',
      'Nopass,nopass@example.com,,Member',
      'Odd,odd@example.com,fake-pass-4,Owner',
    ), roles)
    expect(parsed.users.map((u) => u.email)).toEqual(['ann@example.com'])
    expect(parsed.failed).toEqual([
      { email: 'noname@example.com', reason: 'missing_fields' },
      { email: '', reason: 'missing_fields' },
      { email: 'nopass@example.com', reason: 'missing_fields' },
      { email: 'odd@example.com', reason: 'role', detail: 'Owner' },
    ])
    expect(JSON.stringify(parsed.failed)).not.toContain('fake-pass')
  })

  it('never sends a role it did not find, which the server would read as Member', () => {
    expect(parseBulkCsv(csv('Odd,odd@example.com,fake-pass-4,Owner'), roles).users).toEqual([])
  })

  it('has nothing to say of a file with only its header', () => {
    expect(parseBulkCsv('name,email,password,role,team\n', roles)).toEqual({ users: [], failed: [] })
  })
})
