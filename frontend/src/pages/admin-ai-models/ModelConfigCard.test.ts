import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import en from '@/i18n/locales/en.json'
import type { ModelConfigResponse } from '@/services/api'
import ModelConfigCard from './ModelConfigCard'

// A model that is off still has a description to read and an Edit and a Delete to press.

vi.mock('@/services/confirm', () => ({ useConfirm: () => async () => true }))

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', fallbackLng: 'en', resources: { en: { translation: en } }, interpolation: { escapeValue: false } })
})

const card = (fields: Partial<ModelConfigResponse>) => renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(ModelConfigCard, {
  cfg: { id: 1, name: 'm', provider: 'openai', model: 'x', enabled: true, is_default: false, used_for: [], api_key_env: 'FAKE_KEY_VARIABLE', ...fields } as ModelConfigResponse,
  isEditing: false,
  onEdit: () => {},
  onCancelEdit: () => {},
  onDelete: () => {},
  activateMutation: { isPending: false, mutate: () => {} } as never,
})))
const outer = (html: string) => /^<div class="([^"]*)"/.exec(html)?.[1] ?? ''

describe('a model card that is off', () => {
  it('says Disabled on a neutral card and keeps its text at full strength', () => {
    const html = card({ enabled: false })
    expect(html).toContain('>Disabled<')
    expect(outer(html)).toContain('bg-slate-800/50')
    expect(outer(html)).not.toContain('opacity')
  })
})
