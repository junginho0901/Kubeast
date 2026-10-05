import i18next from 'i18next'
import { beforeAll, describe, expect, it } from 'vitest'
import ko from '../../i18n/locales/ko.json'
import { translateDetailLabel, type TranslateFn } from './detailLabel'

const catalog = (ko as { detail: Record<string, string> }).detail

// Kubernetes kinds and field names stay English: no Korean entry may exist for them.
const ENGLISH_ONLY = ['UID', 'Resource Version', 'Generation', 'Finalizers', 'API Version', 'Selector', 'Owner References', 'ConfigMap', 'QoS Class', 'Taints', 'Tolerations', 'topologyKey:', 'Max Skew', 'Access Modes:']

const placeholders = (s: string) => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort()

describe('detail label catalog', () => {
  it('has no Korean entry for Kubernetes kinds and field names, and no empty entries', () => {
    for (const label of ENGLISH_ONLY) expect(catalog).not.toHaveProperty(label)
    for (const v of Object.values(catalog)) expect(v.trim().length).toBeGreaterThan(0)
  })

  it('keeps every placeholder of a templated label in its Korean entry, and never uses a reserved option name', () => {
    for (const [k, v] of Object.entries(catalog)) {
      expect(placeholders(v), k).toEqual(placeholders(k))
      for (const reserved of ['count', 'context', 'ns', 'lng']) expect(placeholders(k), k).not.toContain(reserved)
    }
  })
})

describe('labels through i18next (the app registers the catalog as the detail namespace)', () => {
  const instance = i18next.createInstance()
  beforeAll(async () => {
    await instance.init({
      lng: 'ko',
      fallbackLng: 'en',
      ns: ['translation', 'detail'],
      defaultNS: 'translation',
      resources: { ko: { translation: ko, detail: catalog }, en: { translation: {}, detail: {} } },
      interpolation: { escapeValue: false },
    })
  })
  const t = (lng: string) => instance.getFixedT(lng) as unknown as TranslateFn

  it('returns the catalog entry when present and the English label otherwise', () => {
    expect(translateDetailLabel(t('ko'), 'Created')).toBe(catalog['Created'])
    expect(translateDetailLabel(t('ko'), 'UID')).toBe('UID')
    expect(translateDetailLabel(t('en'), 'Created')).toBe('Created')
    expect(translateDetailLabel(t('ko'), '')).toBe('')
  })

  it('fills placeholders in the Korean entry and in the English fallback', () => {
    expect(translateDetailLabel(t('ko'), 'Used By Pods ({{n}})', { n: 3 })).toBe(catalog['Used By Pods ({{n}})'].replace('{{n}}', '3'))
    expect(translateDetailLabel(t('en'), 'Used By Pods ({{n}})', { n: 3 })).toBe('Used By Pods (3)')
    expect(translateDetailLabel(t('ko'), 'Not In Catalog ({{n}}{{more}})', { n: 12, more: '+' })).toBe('Not In Catalog (12+)')
  })

  it('looks up labels holding "." or ":" as whole keys', () => {
    expect(translateDetailLabel(t('ko'), 'No data')).toBe(catalog['No data'])
    expect(translateDetailLabel(t('ko'), 'Showing first {{n}} pods.', { n: 5 })).toBe(catalog['Showing first {{n}} pods.'].replace('{{n}}', '5'))
    expect(translateDetailLabel(t('ko'), 'Webhook: {{name}}', { name: 'w1' })).toBe(catalog['Webhook: {{name}}'].replace('{{name}}', 'w1'))
    expect(translateDetailLabel(t('ko'), 'tls.crt')).toBe('tls.crt')
  })
})
