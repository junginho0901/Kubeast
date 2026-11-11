import { describe, expect, it } from 'vitest'
import i18n from 'i18next'

import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import { BULK_CSV_HEADER, bulkCreateFailureRows, bulkCreateFailures, bulkCreateSummary, bulkCsvTemplate, exampleBulkPassword, parseBulkCsv, readBulkCreateAnswer } from './bulkCreate'

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

  it('holds a name to 255 characters, as one account and the server do', () => {
    const at = (n: number) => '가'.repeat(n)
    const parsed = parseBulkCsv(csv(`${at(255)},ann@example.com,fake-pass-1`, `${at(256)},bob@example.com,fake-pass-2`), roles)
    expect(parsed.users.map((u) => u.email)).toEqual(['ann@example.com'])
    expect(parsed.failed).toEqual([{ email: 'bob@example.com', reason: 'name_length' }])
  })

  it('sends the rows it can read, with their role and team', () => {
    expect(parseBulkCsv(csv('Ann,ann@example.com,fake-pass-1,Admin,web', ' Bob , bob@example.com ,fake-pass-2,Member,'), roles)).toEqual({
      users: [
        { name: 'Ann', email: 'ann@example.com', password: 'fake-pass-1', role_id: 2, team: 'web' },
        { name: 'Bob', email: 'bob@example.com', password: 'fake-pass-2', role_id: 1, team: undefined },
      ],
      failed: [],
    })
  })

  it('takes the account level the server takes when a row names no role', () => {
    expect(parseBulkCsv(csv('Ann,ann@example.com,fake-pass-1'), roles).users[0].role_id).toBe(1)
    expect(parseBulkCsv(csv('Ann,ann@example.com,fake-pass-1,,web'), roles).users[0].role_id).toBe(1)
  })

  it('reads a role name as written, as the server keeps it', () => {
    const seeded = [{ id: 1, name: 'Member' }, { id: 2, name: 'Admin' }, { id: 3, name: 'Read' }]
    expect(parseBulkCsv(csv('Ann,ann@example.com,fake-pass-1,read'), seeded)).toEqual({
      users: [],
      failed: [{ email: 'ann@example.com', reason: 'role', detail: 'read' }],
    })
  })

  // Read and Write act per cluster: as an account level they give nothing, and the server moves such an account to Member at its next start.
  it('refuses an account level of Read or Write and says where they belong', () => {
    const seeded = [{ id: 1, name: 'Member' }, { id: 2, name: 'Admin' }, { id: 3, name: 'Read' }, { id: 4, name: 'Write' }]
    expect(parseBulkCsv(csv('Ann,ann@example.com,fake-pass-1,Read', 'Bob,bob@example.com,fake-pass-2,Write', 'Cid,cid@example.com,fake-pass-3,Member'), seeded)).toEqual({
      users: [{ name: 'Cid', email: 'cid@example.com', password: 'fake-pass-3', role_id: 1, team: undefined }],
      failed: [
        { email: 'ann@example.com', reason: 'cluster_role', detail: 'Read' },
        { email: 'bob@example.com', reason: 'cluster_role', detail: 'Write' },
      ],
    })
  })

  it('says why in both languages', async () => {
    const refused = [{ email: 'ann@example.com', reason: 'cluster_role' as const, detail: 'Read' }]
    expect(bulkCreateFailureRows(await tFor('en'), refused)).toEqual(['ann@example.com: Read and Write are granted per cluster and give nothing as an account level: make the account Member and grant the role on a cluster: Read'])
    expect(bulkCreateFailureRows(await tFor('ko'), refused)).toEqual(['ann@example.com: Read와 Write는 클러스터마다 주는 역할이라 계정 등급으로는 권한이 없습니다. 계정은 Member로 만들고 클러스터에서 역할을 주세요: Read'])
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

describe('the template of the bulk upload', () => {
  // the roles auth-service seeds
  const roles = [{ id: 1, name: 'Pending' }, { id: 2, name: 'Member' }, { id: 3, name: 'Read' }, { id: 4, name: 'Write' }, { id: 5, name: 'Admin' }]
  const PASSWORD = 'fake-template-password-for-test'
  // the file as the browser saves it, which starts with a byte order mark
  const asSaved = (teams: string[]) => String.fromCharCode(0xfeff) + bulkCsvTemplate(teams, roles, PASSWORD)

  it('goes up as it is: one account of the account level the server gives by default', () => {
    expect(parseBulkCsv(asSaved(['web']), roles)).toEqual({
      users: [{ name: 'Hong Gildong', email: 'hong@example.com', password: PASSWORD, role_id: 2, team: 'web' }],
      failed: [],
    })
  })

  it('goes up as it is on a server with no team registered, which refuses a team it does not have', () => {
    expect(parseBulkCsv(asSaved([]), roles)).toEqual({
      users: [{ name: 'Hong Gildong', email: 'hong@example.com', password: PASSWORD, role_id: 2, team: undefined }],
      failed: [],
    })
  })

  it('writes the columns the format line says and the parser reads, in that order', () => {
    const cell: Record<string, string> = { name: 'Ann', email: 'ann@example.com', password: PASSWORD, role: 'Admin', team: 'web' }
    const row = BULK_CSV_HEADER.split(',').map((column) => cell[column] ?? 'not-a-column').join(',')
    expect(parseBulkCsv(`${BULK_CSV_HEADER}\n${row}\n`, roles).users).toEqual([{ name: 'Ann', email: 'ann@example.com', password: PASSWORD, role_id: 5, team: 'web' }])
    expect(bulkCsvTemplate([], roles, PASSWORD).split('\n')).toContain(BULK_CSV_HEADER)
  })

  it('names the teams and the account levels in its comments', () => {
    const comments = bulkCsvTemplate(['web', 'db'], roles, PASSWORD).split('\n').filter((l) => l.startsWith('#'))
    expect(comments).toEqual(['# Available Team: web, db', '# role (account level): Member, Admin'])
  })

  // The example goes up as it is, so a password every template shares would be an account anyone can sign in to.
  it('gives each download a password of its own that the default policy takes', () => {
    const first = exampleBulkPassword()
    expect(first).not.toBe(exampleBulkPassword())
    expect(first.length).toBeGreaterThanOrEqual(12)
    expect(first).toMatch(/^[0-9a-f]+$/)
  })
})
