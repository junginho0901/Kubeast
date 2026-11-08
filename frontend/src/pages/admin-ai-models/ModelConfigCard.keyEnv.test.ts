import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import en from '@/i18n/locales/en.json'
import type { ModelConfigResponse } from '@/services/api'
import ModelConfigCard from './ModelConfigCard'

// ai-service reads a key through api_key_env or the older api_key_secret_key, so the card warns only when neither names a variable.

vi.mock('@/services/confirm', () => ({ useConfirm: () => async () => true }))

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', fallbackLng: 'en', resources: { en: { translation: en } }, interpolation: { escapeValue: false } })
})

const card = (fields: Partial<ModelConfigResponse>) => renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(ModelConfigCard, {
  cfg: { id: 1, name: 'm', provider: 'openai', model: 'x', enabled: true, is_default: false, used_for: [], ...fields } as ModelConfigResponse,
  isEditing: false,
  onEdit: () => {},
  onCancelEdit: () => {},
  onDelete: () => {},
  activateMutation: { isPending: false, mutate: () => {} } as never,
})))
const NO_KEY = 'No key env'

describe('the AI Models card says what the model runs with', () => {
  it('names the variable in the older field and does not warn', () => {
    const html = card({ api_key_env: null, api_key_secret_key: 'FAKE_KEY_VARIABLE' })
    expect(html).toContain('FAKE_KEY_VARIABLE')
    expect(html).not.toContain(NO_KEY)
  })

  it('names the variable of the newer field first', () => {
    const html = card({ api_key_env: 'FAKE_NEW_VARIABLE', api_key_secret_key: 'FAKE_KEY_VARIABLE' })
    expect(html).toContain('FAKE_NEW_VARIABLE')
    expect(html).not.toContain('FAKE_KEY_VARIABLE')
  })

  it('warns when neither names one', () => {
    expect(card({ api_key_env: null, api_key_secret_key: null })).toContain(NO_KEY)
    expect(card({ api_key_env: null, api_key_secret_key: '' })).toContain(NO_KEY)
  })

  it('says nothing for a provider that asks for no key', () => {
    expect(card({ provider: 'ollama', api_key_env: null, api_key_secret_key: null })).not.toContain(NO_KEY)
  })
})
