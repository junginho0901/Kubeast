import { describe, expect, it } from 'vitest'
import en from '../i18n/locales/en.json'
import ko from '../i18n/locales/ko.json'

type Catalog = { adminRoles: { catalog: { permission: Record<string, string> } } }

// resource.*.read opens the lists and details and what asks more (k8s-service read_gate.go), and the cluster's RBAC still
// decides what the group sees. resource.objects.read opens the lists and details alone.
describe('the role screen\'s read permissions', () => {
  const english = (en as unknown as Catalog).adminRoles.catalog.permission
  const korean = (ko as unknown as Catalog).adminRoles.catalog.permission

  it('says resource.*.read opens the lists and details', () => {
    expect(english.resource_all_read).toContain('lists and details')
    expect(korean.resource_all_read).toContain('목록·상세')
  })

  it('names what else resource.*.read opens', () => {
    for (const word of ['Pod logs', 'log search', 'Alerts', 'Helm', 'Cost', 'Policy Reports', 'network']) expect(english.resource_all_read, word).toContain(word)
    for (const word of ['Pod 로그', '로그 검색', 'Alerts', 'Helm', 'Cost', 'Policy Reports', '네트워크']) expect(korean.resource_all_read, word).toContain(word)
  })

  it('says the cluster still decides what the group sees', () => {
    expect(english.resource_all_read).toContain("cluster's RBAC")
    expect(korean.resource_all_read).toContain('클러스터 RBAC')
  })

  it('says resource.objects.read opens the lists and details and not what asks more', () => {
    expect(english.resource_objects_read).toMatch(/^Lists and details .*without Pod logs, .*Helm, Cost/)
    expect(korean.resource_objects_read).toMatch(/목록·상세.*Pod 로그.*Helm.*Cost.*열지 않습니다/)
  })

  it('says a role with neither reads nothing', () => {
    expect(english.resource_objects_read).toMatch(/Without this or All resources: read .*nothing/)
    expect(korean.resource_objects_read).toMatch(/resource\.\*\.read도 없으면 .*읽지 못합니다/)
  })
})
