import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import { NoManifestDiff } from './RollbackModal'

vi.mock('@/hooks/useAIContext', () => ({ useAIContext: () => {} }))
vi.mock('./DiffView', () => ({ default: () => null }))

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en', fallbackLng: 'en', resources: { en: { translation: en }, ko: { translation: ko } }, interpolation: { escapeValue: false },
  })
})

const render = (canReveal: boolean, lng = 'en') =>
  renderToStaticMarkup(createElement(I18nextProvider, { i18n: i18n.cloneInstance({ lng }) }, createElement(NoManifestDiff, { canReveal }))).replaceAll('&#x27;', "'")

// An empty diff compares what the caller can read of two manifests. The rollback still writes a revision, and values the
// chart does not render or that are masked for this caller can differ.
describe('the rollback window with an empty diff', () => {
  it('does not promise that nothing changes', () => {
    expect(en.helmReleaseDetail.rollback.noChange).not.toBe('No changes will be applied.')
    expect(ko.helmReleaseDetail.rollback.noChange).not.toBe('적용될 변경이 없습니다.')
  })

  it('says the manifests read the same and a new revision is still recorded', () => {
    expect(render(true)).toContain(en.helmReleaseDetail.rollback.noChange)
    expect(render(true, 'ko')).toContain(ko.helmReleaseDetail.rollback.noChange)
    expect(en.helmReleaseDetail.rollback.noChange).toContain('new revision')
  })

  it('tells a caller who cannot read hidden values that those are not compared', () => {
    expect(render(false)).toContain(en.helmReleaseDetail.rollback.noChangeMasked)
    expect(render(false, 'ko')).toContain(ko.helmReleaseDetail.rollback.noChangeMasked)
    expect(en.helmReleaseDetail.rollback.noChangeMasked).toContain('hidden')
    expect(ko.helmReleaseDetail.rollback.noChangeMasked).toContain('숨겨진 값')
    expect(render(true)).not.toContain('hidden')
  })
})
