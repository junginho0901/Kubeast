import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import SetupClusterPage from './SetupClusterPage'

const tr = (_key: string, fallback: string) => fallback
const page = (props: Partial<Parameters<typeof SetupClusterPage>[0]>) =>
  renderToStaticMarkup(createElement(SetupClusterPage, {
    mode: 'in_cluster', setMode: () => undefined, kubeconfigText: '', setKubeconfigText: () => undefined, error: null,
    isApplying: false, isBusy: false, isLoadingStatus: false, inClusterOff: false, canSubmit: true, onSubmit: () => undefined, tr,
    ...props,
  }))
const inClusterButton = (html: string) => html.match(/<button[^>]*data-testid="setup-option-in-cluster"[^>]*>/)?.[0] ?? ''
const closed = (button: string) => /\sdisabled=""/.test(button)

describe('SetupClusterPage', () => {
  it('on a Docker install "Use this cluster" is closed and says why', () => {
    const html = page({ mode: 'external', inClusterOff: true })
    expect(closed(inClusterButton(html))).toBe(true)
    expect(html).toContain('Not available in docker mode')
    expect(html).not.toContain('Manage the cluster where this solution is installed.')
    expect(html).toContain('Paste kubeconfig content here...')
  })

  it('on a cluster install "Use this cluster" stays open', () => {
    const html = page({})
    expect(inClusterButton(html)).not.toBe('')
    expect(closed(inClusterButton(html))).toBe(false)
    expect(html).toContain('Manage the cluster where this solution is installed.')
  })

  it('the texts the wizard reads are in both catalogs', () => {
    for (const cat of [en, ko] as Array<{ setup: Record<string, unknown> & { errors: Record<string, string> } }>) {
      expect(typeof cat.setup.submitLoading).toBe('string')
      expect(cat.setup['submit.loading']).toBeUndefined()
      expect(typeof cat.setup.errors.timeoutInCluster).toBe('string')
    }
    expect(ko.setup.submitLoading).toBe('적용 중...')
  })
})
