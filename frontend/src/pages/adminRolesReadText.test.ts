import { describe, expect, it } from 'vitest'
import en from '../i18n/locales/en.json'
import ko from '../i18n/locales/ko.json'

type Catalog = { adminRoles: { catalog: { permission: Record<string, string> } } }

// resource.*.read does not open the lists: the role on the cluster and the cluster's RBAC do. The routes that ask for it
// (raw route survey of k8s-service) are the logs, Helm, Cost, policy reports and the network reads.
describe('the role screen\'s resource.*.read', () => {
  const english = (en as unknown as Catalog).adminRoles.catalog.permission.resource_all_read
  const korean = (ko as unknown as Catalog).adminRoles.catalog.permission.resource_all_read

  it('does not promise every resource', () => {
    expect(english).not.toMatch(/all resources/i)
    expect(korean).not.toContain('모든 리소스')
  })

  it('names what asks for it', () => {
    for (const word of ['Pod logs', 'log search', 'Alerts', 'Helm', 'Cost', 'Policy Reports', 'network']) expect(english, word).toContain(word)
    for (const word of ['Pod 로그', '로그 검색', 'Alerts', 'Helm', 'Cost', 'Policy Reports', '네트워크']) expect(korean, word).toContain(word)
  })

  it('says the cluster decides the other lists', () => {
    expect(english).toMatch(/other lists.*cluster's RBAC/)
    expect(korean).toMatch(/다른 목록.*클러스터 RBAC/)
  })
})
