import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { beforeAll, describe, expect, it } from 'vitest'

import en from '../../i18n/locales/en.json'
import ko from '../../i18n/locales/ko.json'
import { DescribeFailure } from './DescribeFailure'

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: en }, ko: { translation: ko } }, interpolation: { escapeValue: false } })
})
const render = (error: unknown, showingRow = false) =>
  renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(DescribeFailure, { error, showingRow })))
const REFUSED = {
  response: { status: 403, data: { detail: 'roles.rbac.authorization.k8s.io "app" is forbidden: User "u" cannot get resource "roles" in the namespace "shop"' } },
  message: 'Request failed with status code 403',
}

describe("the line a drawer's failed read leaves", () => {
  it("says the details were not read, with the server's reason, not a fixed sentence", () => {
    const line = render(REFUSED)
    expect(line).toContain('Could not read the details: roles.rbac.authorization.k8s.io &quot;app&quot; is forbidden')
    expect(line).not.toContain('status code')
    expect(line).toContain('role="alert"')
    expect(line).toContain('data-testid="describe-failed"')
  })

  it("says what is still on screen comes from the list's row", () => {
    expect(render(REFUSED, true)).toContain("Showing what the list&#x27;s row holds.")
  })

  it('draws nothing without an error, and the request error when the server gave no reason', () => {
    expect(render(null)).toBe('')
    expect(render({ message: 'Network Error' })).toContain('Could not read the details: Network Error')
  })

  it('has a Korean line', async () => {
    await i18n.changeLanguage('ko')
    try {
      expect(render(REFUSED, true)).toMatch(/상세 정보를 읽지 못했습니다: .*forbidden.* 목록 줄에 있는 값만 보입니다\./)
    } finally {
      await i18n.changeLanguage('en')
    }
  })
})
