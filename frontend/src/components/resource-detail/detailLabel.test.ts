import { describe, expect, it } from 'vitest'
import ko from '../../i18n/locales/ko.json'
import { detailLabelKey, translateDetailLabel } from './detailLabel'

const catalog = (ko as { detail: Record<string, string> }).detail

// Kubernetes kinds and field names stay English: no Korean entry may exist for them.
const ENGLISH_ONLY = ['UID', 'Resource Version', 'Generation', 'Finalizers', 'API Version', 'Selector', 'Owner References', 'ConfigMap', 'QoS Class', 'Taints', 'Tolerations']

describe('detail label catalog', () => {
  it('keys descriptive labels under detail.* and leaves identifiers with dots alone', () => {
    expect(detailLabelKey('Created')).toBe('detail.Created')
    expect(detailLabelKey('Resource Version')).toBe('detail.Resource Version')
    expect(detailLabelKey('tls.crt')).toBeNull()
    expect(detailLabelKey('')).toBeNull()
  })

  it('returns the catalog entry when present and the English label otherwise', () => {
    const t = (key: string, { defaultValue }: { defaultValue: string }) => {
      const k = key.replace(/^detail\./, '')
      return k in catalog ? catalog[k] : defaultValue
    }
    expect(translateDetailLabel(t, 'Created')).toBe(catalog['Created'])
    expect(translateDetailLabel(t, 'UID')).toBe('UID')
    expect(translateDetailLabel(t, 'tls.crt')).toBe('tls.crt')
  })

  it('has no Korean entry for Kubernetes kinds and field names, and no empty or dotted keys', () => {
    for (const label of ENGLISH_ONLY) expect(catalog).not.toHaveProperty(label)
    for (const [k, v] of Object.entries(catalog)) {
      expect(k).not.toMatch(/[.:]/)
      expect(v.trim().length).toBeGreaterThan(0)
    }
  })
})
