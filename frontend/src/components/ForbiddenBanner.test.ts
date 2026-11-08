import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import en from '../i18n/locales/en.json'
import ko from '../i18n/locales/ko.json'
import ForbiddenBanner from './ForbiddenBanner'
import { hasPermission, type PermissionMatrix } from '@/utils/permissions'

const state: { matrix: PermissionMatrix; clusterRole: string | null } = { matrix: {}, clusterRole: null }

vi.mock('react-router-dom', () => ({ useLocation: () => ({ pathname: '/configmaps' }) }))
vi.mock('@/services/forbiddenStore', () => ({ resetForbidden: () => undefined, useForbiddenLabels: () => ['ConfigMaps'] }))
vi.mock('@/services/listStatusStore', () => ({ resetListStatus: () => undefined }))
vi.mock('@/services/watchProblemStore', () => ({ resetWatchProblems: () => undefined }))
vi.mock('@/hooks/usePermission', () => ({
  usePermission: () => ({
    has: (perm: string) => hasPermission(state.matrix, perm, 'c1'),
    permissions: state.matrix,
    clusterRole: state.clusterRole,
    clusterNamespaces: null,
  }),
}))

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: en }, ko: { translation: ko } }, interpolation: { escapeValue: false } })
})

const drawn = (lng = 'en') => {
  void i18n.changeLanguage(lng)
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(ForbiddenBanner, { clusterKey: 'c1' })))
}

describe('why a custom role is refused', () => {
  beforeEach(() => {
    state.clusterRole = 'ops-team'
  })

  it('names the permission when the role does not hold it, and does not blame the cluster', () => {
    state.matrix = { c1: ['menu.*', 'ai.tool.*'] }
    const html = drawn()
    expect(html).toContain('data-testid="forbidden-read-permission-hint"')
    expect(html).toContain('resource.objects.read')
    expect(html).not.toContain('data-testid="forbidden-custom-role-hint"')
  })

  it('says so in Korean too', () => {
    state.matrix = { c1: ['menu.*'] }
    const html = drawn('ko')
    expect(html).toContain('resource.objects.read')
    expect(html).toContain('관리자')
  })

  it.each([['the key', ['resource.objects.read']], ['the wildcard', ['resource.*.read']]])('points at the cluster for a role holding %s', (_name, perms) => {
    state.matrix = { c1: perms as string[] }
    const html = drawn()
    expect(html).toContain('data-testid="forbidden-custom-role-hint"')
    expect(html).not.toContain('data-testid="forbidden-read-permission-hint"')
  })

  it('does not count the key on another cluster', () => {
    state.matrix = { c1: ['menu.*'], c2: ['resource.objects.read'] }
    expect(drawn()).toContain('data-testid="forbidden-read-permission-hint"')
  })

  it('says nothing of a role to a built-in role', () => {
    state.clusterRole = 'Read'
    state.matrix = { c1: ['menu.*', 'resource.*.read'] }
    const html = drawn()
    expect(html).not.toContain('data-testid="forbidden-read-permission-hint"')
    expect(html).not.toContain('data-testid="forbidden-custom-role-hint"')
  })
})
