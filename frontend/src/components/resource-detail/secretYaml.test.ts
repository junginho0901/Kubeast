import { describe, expect, it } from 'vitest'
import { decodeSecretYaml, encodeSecretYaml } from './utils'

// What the YAML window of a Secret does to the text the server sends: a caller who may edit reads data as stringData and
// saves it back as data. k8s-service's secret_apply_masks_test.go holds the server to the bytes pinned here.
describe('the Secret YAML window', () => {
  const masked = "apiVersion: v1\ndata:\n    password: '***'\n    user: '***'\nkind: Secret\nmetadata:\n    name: db\ntype: Opaque\n"

  it('shows a masked value as the server sent it, under stringData', () => {
    expect(decodeSecretYaml(masked)).toBe("apiVersion: v1\nstringData:\n    password: '***'\n    user: '***'\nkind: Secret\nmetadata:\n    name: db\ntype: Opaque\n")
  })

  it('saves a masked value as the base64 of its characters and quotes, which the server takes for the mask', () => {
    expect(encodeSecretYaml(decodeSecretYaml(masked))).toBe('apiVersion: v1\ndata:\n    password: JyoqKic=\n    user: JyoqKic=\nkind: Secret\nmetadata:\n    name: db\ntype: Opaque\n')
    expect(atob('JyoqKic=')).toBe("'***'")
  })

  it('round-trips a value the caller may read', () => {
    const shown = decodeSecretYaml(`apiVersion: v1\ndata:\n    password: ${btoa('fake-value')}\nkind: Secret\n`)
    expect(shown).toContain('password: fake-value')
    expect(encodeSecretYaml(shown)).toContain(`password: ${btoa('fake-value')}`)
  })
})
