import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import type { HelmUpgradeResponse } from '@/services/api'
import UpgradePreviewModal from './UpgradePreviewModal'
import { failedPreview } from './upgradePreview'

// The preview of a values edit: Apply opens for anything the edit changes, also when the masked diff cannot show it.

vi.mock('@tanstack/react-query', async (original) => ({
  ...(await original<typeof import('@tanstack/react-query')>()),
  useMutation: () => ({ isPending: false, mutate: () => {} }),
  useQueryClient: () => ({ invalidateQueries: () => {} }),
}))
vi.mock('@/components/ModalOverlay', () => ({ ModalOverlay: ({ children }: { children: ReactNode }) => children }))
const aiContext = vi.fn()
vi.mock('@/hooks/useAIContext', () => ({ useAIContext: (snapshot: unknown) => aiContext(snapshot) }))
vi.mock('./DiffView', () => ({ default: ({ diff }: { diff: string }) => createElement('pre', { 'data-testid': 'diff' }, diff) }))

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en', fallbackLng: 'en', resources: { en: { translation: en }, ko: { translation: ko } }, interpolation: { escapeValue: false },
  })
})
beforeEach(() => aiContext.mockClear())

const preview = (fields: Partial<HelmUpgradeResponse>): HelmUpgradeResponse => ({ dryRun: true, fromRevision: 3, chartVersion: '1.0.0', ...fields })

const render = (fields: Partial<HelmUpgradeResponse>, lng = 'en') =>
  renderToStaticMarkup(createElement(I18nextProvider, { i18n: i18n.cloneInstance({ lng }) },
    createElement(UpgradePreviewModal, { namespace: 'team-a', name: 'app', values: 'a: 1\n', preview: preview(fields), onClose: () => {}, onApplied: () => {} })))

// The opening tag of the button that says text.
const button = (html: string, text: string) => html.split('<button').find((part) => part.includes(text))?.split('>')[0] ?? ''
const applyOff = (html: string, lng: 'en' | 'ko' = 'en') => {
  const tag = button(html, lng === 'en' ? en.helmReleaseDetail.upgrade.apply : ko.helmReleaseDetail.upgrade.apply)
  expect(tag).not.toBe('')
  return tag.includes(' disabled=""')
}
const named = (html: string) => /data-testid="helm-upgrade-changed-masked">([^<]*)</.exec(html)?.[1]

// A preview that failed has nothing to apply: what the server said is no diff.
describe('a values preview that failed', () => {
  const failed = (err: unknown) => failedPreview(err) as HelmUpgradeResponse
  const refused = { response: { data: { detail: 'Values: yaml: line 3: mapping values are not allowed' } } }
  const draw = (fields: HelmUpgradeResponse, lng = 'en') =>
    renderToStaticMarkup(createElement(I18nextProvider, { i18n: i18n.cloneInstance({ lng }) },
      createElement(UpgradePreviewModal, { namespace: 'team-a', name: 'app', values: 'a: 1\n', preview: fields, onClose: () => {}, onApplied: () => {} })))

  it('keeps Apply off', () => {
    expect(applyOff(draw(failed(refused)))).toBe(true)
  })

  it('shows what the server said as an error, not as a diff', () => {
    const html = draw(failed(refused))
    expect(html).not.toContain('data-testid="diff"')
    expect(/data-testid="helm-upgrade-preview-failed"[^>]*>([^<]*)</.exec(html)?.[1]).toBe('Values: yaml: line 3: mapping values are not allowed')
    expect(html).not.toContain(en.helmReleaseDetail.upgrade.noChange)
  })

  it('reads the message of a failure the server did not answer', () => {
    expect(/data-testid="helm-upgrade-preview-failed"[^>]*>([^<]*)</.exec(draw(failed(new Error('Network Error'))))?.[1]).toBe('Network Error')
  })

  it('tells the assistant the preview failed, not that a change is on its way', () => {
    draw(failed(refused))
    const snapshot = aiContext.mock.calls.at(-1)![0] as { summary: string; data: Record<string, unknown> }
    expect(snapshot.data.preview_error).toBe('Values: yaml: line 3: mapping values are not allowed')
    expect(snapshot.data.diff).toBe('')
    expect(snapshot.summary).toContain('미리보기 실패')
    expect(snapshot.summary).not.toContain('manifest 차이 있음')
  })

  it('says the server\'s refusal as it came, in both languages, with Apply off, and tells the assistant why', () => {
    const refusal = 'the values hold a masked placeholder where it stands for no value (note): write the value there, or put the line back as it was shown'
    for (const lng of ['en', 'ko'] as const) {
      aiContext.mockClear()
      const html = draw(failed({ response: { data: { detail: refusal } } }), lng)
      expect(/data-testid="helm-upgrade-preview-failed"[^>]*>([^<]*)</.exec(html)?.[1]).toBe(refusal)
      expect(applyOff(html, lng)).toBe(true)
      expect(html).not.toContain('data-testid="diff"')
      expect(html).not.toContain((lng === 'en' ? en : ko).helmReleaseDetail.upgrade.noChange)
      const snapshot = aiContext.mock.calls.at(-1)![0] as { summary: string; data: Record<string, unknown> }
      expect(snapshot.data.preview_error).toBe(refusal)
      expect(snapshot.summary).toContain('미리보기 실패')
      expect(snapshot.summary).toContain(refusal)
    }
  })
})

describe('the values upgrade preview', () => {
  it('opens Apply and says where when all it changes is hidden from the diff', () => {
    const html = render({ diff: '', values_changed: true, changed_masked: ['adminPassword', 'db.url'] })
    expect(applyOff(html)).toBe(false)
    expect(html).not.toContain(en.helmReleaseDetail.upgrade.noChange)
    expect(html).toContain(en.helmReleaseDetail.upgrade.noDiffValuesChange)
    expect(named(html)).toBe('Hidden values you wrote over or removed: adminPassword, db.url')
  })

  it('says so in Korean too', () => {
    const html = render({ diff: '', values_changed: true, changed_masked: ['adminPassword'] }, 'ko')
    expect(applyOff(html, 'ko')).toBe(false)
    expect(html).not.toContain(ko.helmReleaseDetail.upgrade.noChange)
    expect(html).toContain(ko.helmReleaseDetail.upgrade.noDiffValuesChange)
    expect(named(html)).toBe('새 값을 쓰거나 지운 숨겨진 값: adminPassword')
  })

  it('opens Apply when the values change and nothing shows in the manifest, and says that is what happens', () => {
    const html = render({ diff: '', values_changed: true })
    expect(applyOff(html)).toBe(false)
    expect(html).not.toContain(en.helmReleaseDetail.upgrade.noChange)
    expect(html).toContain('No difference shows in the manifest, but these values differ from the ones shown and will be saved.')
    expect(named(html)).toBeUndefined()
  })

  it('says that in Korean too', () => {
    const html = render({ diff: '', values_changed: true }, 'ko')
    expect(applyOff(html, 'ko')).toBe(false)
    expect(html).not.toContain(ko.helmReleaseDetail.upgrade.noChange)
    expect(html).toContain('화면에 보이는 차이는 없지만 이 values는 지금 보이는 것과 달라 새로 저장됩니다.')
  })

  it('tells the assistant the values change when nothing shows in the manifest', () => {
    render({ diff: '', values_changed: true })
    const snapshot = aiContext.mock.calls[0][0] as { summary: string; data: Record<string, unknown> }
    expect(snapshot.data.values_changed).toBe(true)
    expect(snapshot.summary).not.toContain('바뀌는 것 없음')
    expect(snapshot.summary).toContain('values')
  })

  it('gives the assistant the same places and does not tell it nothing changes', () => {
    render({ diff: '', values_changed: true, changed_masked: ['adminPassword'], kept_masked: ['dbPassword'] })
    const snapshot = aiContext.mock.calls[0][0] as { summary: string; data: Record<string, unknown> }
    expect(snapshot.data.changed_masked).toEqual(['adminPassword'])
    expect(snapshot.data.kept_masked).toEqual(['dbPassword'])
    expect(snapshot.summary).not.toContain('바뀌는 것 없음')
    expect(snapshot.summary).toContain('adminPassword')
  })

  it('still says what stays beside what was written over', () => {
    const html = render({ diff: '', values_changed: true, changed_masked: ['adminPassword'], kept_masked: ['dbPassword'] })
    expect(html).toContain('Hidden values stay as they are: dbPassword')
    expect(named(html)).toBe('Hidden values you wrote over or removed: adminPassword')
  })

  it('shows the diff beside the places when there is one', () => {
    const html = render({ diff: '--- a\n+++ b\n', values_changed: true, changed_masked: ['adminPassword'] })
    expect(applyOff(html)).toBe(false)
    expect(html).toContain('data-testid="diff"')
    expect(html).not.toContain(en.helmReleaseDetail.upgrade.noDiffValuesChange)
    expect(named(html)).toBe('Hidden values you wrote over or removed: adminPassword')
  })

  it('keeps Apply off when nothing changes', () => {
    const html = render({ diff: '' })
    expect(applyOff(html)).toBe(true)
    expect(html).toContain(en.helmReleaseDetail.upgrade.noChange)
    expect(named(html)).toBeUndefined()
    const snapshot = aiContext.mock.calls[0][0] as { summary: string }
    expect(snapshot.summary).toContain('바뀌는 것 없음')
  })

  it('leaves a diff with no hidden change as it was', () => {
    const html = render({ diff: '--- a\n+++ b\n' })
    expect(applyOff(html)).toBe(false)
    expect(html).toContain('data-testid="diff"')
    expect(named(html)).toBeUndefined()
  })
})
