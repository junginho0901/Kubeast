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

const card = (fields: Partial<ModelConfigResponse>, isEditing = false) => renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(ModelConfigCard, {
  cfg: { id: 1, name: 'm', provider: 'openai', model: 'x', enabled: true, is_default: false, used_for: [], api_key_env: 'FAKE_KEY_VARIABLE', ...fields } as ModelConfigResponse,
  isEditing,
  onEdit: () => {},
  onCancelEdit: () => {},
  onDelete: () => {},
  activateMutation: { isPending: false, mutate: () => {} } as never,
})))
const outer = (html: string) => /^<div class="([^"]*)"/.exec(html)?.[1] ?? ''
const buttons = (html: string) => [...html.matchAll(/<button[^>]*class="([^"]*)"[^>]*title="([^"]*)"/g)].map((m) => ({ cls: m[1], title: m[2] }))

describe('a model card that is off', () => {
  it('says Disabled on a neutral card and keeps its text at full strength', () => {
    const html = card({ enabled: false })
    expect(html).toContain('>Disabled<')
    expect(outer(html)).toContain('bg-slate-800/50')
    expect(outer(html)).not.toContain('opacity')
  })
})

describe("a model card's actions", () => {
  it('are the shared row buttons with their names, the delete one in its red', () => {
    const html = card({})
    expect(buttons(html)).toEqual([
      { cls: 'btn-row gap-1 px-2 py-1 text-[11px] font-medium', title: 'Set as Active' },
      { cls: 'btn-row p-[5px]', title: 'Edit' },
      { cls: 'btn-row-danger p-[5px]', title: 'Delete' },
    ])
    expect(html).toContain('Activate</button>')
    expect(html).not.toContain('emerald-500/10')
  })

  it('keep the edit button marked while its form is open', () => {
    const edit = buttons(card({}, true)).find((b) => b.title === 'Close edit')
    expect(edit?.cls).toBe('btn-row p-[5px] bg-primary-500/20 text-primary-400')
  })
})
