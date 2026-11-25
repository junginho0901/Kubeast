import { describe, expect, it } from 'vitest'
import type { ModelUseState } from '@/services/api'
import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import { linesOf, type Tr } from './perUse'

// What a use's field says under it (AI Models, "Which model answers"), in the words of the call's default or of a catalog.

const fill = (text: string, o: Record<string, unknown> = {}) => text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(o[name]))
const byDefault: Tr = (_key, fb, o) => fill(fb, o)
const from = (catalog: unknown): Tr => (key, _fb, o) =>
  fill(key.split('.').reduce<unknown>((at, part) => (at as Record<string, unknown>)[part], catalog) as string, o)

const state = (fields: Partial<ModelUseState>): ModelUseState => ({
  use: 'investigation', on: true, choice: null, answers: { id: 1, name: 'chat' }, by: 'chat', problem: '', chart_model: '', daily_token_budget: null, ...fields,
})
const texts = (fields: Partial<ModelUseState>, tr: Tr = byDefault) => linesOf(state(fields), tr).map((line) => line.text)

describe('what a use says under its field', () => {
  it('names what answers it now, or the chart when no model is stored', () => {
    expect(texts({})).toEqual(['Answers now: chat'])
    expect(texts({ answers: null })).toEqual(["Answers now: the model of the chart's ai.* values"])
  })

  it('says the daily budget in tokens, whichever model answers, and when there is none', () => {
    expect(texts({ daily_token_budget: 200000 })).toEqual([
      'Answers now: chat', 'Daily budget: 200,000 tokens (UTC). It counts tokens, not money, whichever model answers.',
    ])
    expect(texts({ daily_token_budget: 0 })).toEqual(['Answers now: chat', 'No daily budget.'])
  })

  it('says why it would not run instead of what answers, and a disabled choice beside what does', () => {
    expect(linesOf(state({ answers: null, problem: 'model config "gone" (features.alertInvestigation.model) not found' }), byDefault)).toEqual([
      { text: 'Does not run now: model config "gone" (features.alertInvestigation.model) not found', problem: true },
    ])
    expect(linesOf(state({ choice: { id: 2, name: 'strong', enabled: false } }), byDefault)).toEqual([
      { text: '"strong" is disabled, so it does not answer.', problem: true }, { text: 'Answers now: chat' },
    ])
  })

  it('says an investigation that is off on this install', () => {
    expect(texts({ on: false })).toEqual(['Answers now: chat', 'Off on this install'])
  })

  it("the English catalog says the same as the calls' defaults, and the Korean one says each", () => {
    for (const fields of [
      {}, { answers: null }, { daily_token_budget: 200000 }, { daily_token_budget: 0, on: false },
      { problem: 'no key' }, { choice: { id: 2, name: 'strong', enabled: false } },
    ] satisfies Partial<ModelUseState>[]) {
      expect(texts(fields, from(en))).toEqual(texts(fields))
      expect(texts(fields, from(ko))).toHaveLength(texts(fields).length)
    }
  })
})
