import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { beforeAll, describe, expect, it } from 'vitest'

import en from '../i18n/locales/en.json'
import ko from '../i18n/locales/ko.json'
import { ActionFailure, type FailedAction } from './ActionFailure'

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: en }, ko: { translation: ko } }, interpolation: { escapeValue: false } })
})
const render = (error: unknown, action: FailedAction) =>
  renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(ActionFailure, { error, action, testId: 'f' })))
const REFUSED = { response: { status: 403, data: { detail: 'forbidden: resource.node.cordon required' } }, message: 'Request failed with status code 403' }

describe('the line an action the server refused leaves', () => {
  it("says what did not happen and the server's reason", () => {
    expect(render(REFUSED, 'change')).toContain('Not changed: forbidden: resource.node.cordon required')
    expect(render(REFUSED, 'revoke')).toContain('Not revoked: forbidden: resource.node.cordon required')
    expect(render(REFUSED, 'change')).toContain('role="alert"')
  })

  it('has a Korean line for every action', async () => {
    await i18n.changeLanguage('ko')
    try {
      for (const action of ['delete', 'save', 'change', 'revoke', 'end', 'cancel', 'rollback'] as FailedAction[]) {
        expect(render(REFUSED, action)).toMatch(/못했습니다: forbidden: resource\.node\.cordon required/)
      }
    } finally {
      await i18n.changeLanguage('en')
    }
  })

  it('is nothing without an error', () => {
    expect(render(null, 'delete')).toBe('')
    expect(render(undefined, 'delete')).toBe('')
  })
})
