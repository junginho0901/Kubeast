import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import { CreateUserModal } from './CreateUserModal'

// The window keeps what was typed after a refusal, so what it says has to be enough to change the right field.

// the frame's overlay is a portal, which the server renderer does not draw
vi.mock('@/components/ModalFrame', () => ({
  ModalFrame: ({ children, footer }: { children: unknown; footer: unknown }) => createElement('div', null, children as never, footer as never),
}))

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en', fallbackLng: 'en', resources: { en: { translation: en }, ko: { translation: ko } }, interpolation: { escapeValue: false },
  })
})

const refused = (status: number, detail?: string) => Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data: detail ? { detail } : {} } })

const render = (error: unknown, lng = 'en') => {
  const inst = i18n.cloneInstance({ lng })
  const mutation = { isPending: false, isError: !!error, error, mutate: () => {} }
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n: inst }, createElement(CreateUserModal, {
    open: true,
    newUser: { name: 'A', email: 'a@example.com', password: 'fake-password-for-test', role_id: 2, team: '' },
    onChangeNewUser: () => {},
    teamOptions: [],
    roles: [],
    mutation: mutation as never,
    onClose: () => {},
    tr: ((key: string, fallback: string, opts?: Record<string, unknown>) => inst.t(key, fallback, opts as never)) as never,
  })))
}

describe('the window that creates a user, when the server refuses', () => {
  it('says the email already has an account', () => {
    expect(render(refused(409, 'Email already exists'))).toContain('Failed to create user: Email already exists')
  })

  it('says which permissions the role would give beyond what the caller holds', () => {
    const detail = 'permission ceiling: cannot grant permissions you do not hold: admin.users.delete'
    expect(render(refused(403, detail))).toContain(`Failed to create user: ${detail}`)
  })

  it('says why the name cannot be an account name', () => {
    const detail = 'this name cannot be a Kubernetes user: an account name may not contain a colon, a space or a control character'
    expect(render(refused(400, detail))).toContain(`Failed to create user: ${detail}`)
  })

  it('says what the password policy asks', () => {
    expect(render(refused(400, 'password must be at least 12 characters'))).toContain('password must be at least 12 characters')
  })

  it('says the same in Korean, with the server words as the server wrote them', () => {
    expect(render(refused(409, 'Email already exists'), 'ko')).toContain('사용자 생성에 실패했습니다: Email already exists')
  })

  it('says what the browser knows when no answer came', () => {
    expect(render(new Error('Network Error'))).toContain('Failed to create user: Network Error')
  })

  it('says only that it failed when there is nothing more to say', () => {
    const html = render(new Error(''))
    expect(html).toContain('Failed to create user.')
    expect(html).not.toContain('Failed to create user:')
  })

  it('says nothing before a refusal', () => {
    expect(render(null)).not.toContain('Failed to create user')
  })
})
