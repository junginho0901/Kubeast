import { parse } from 'diff2html'
import { describe, expect, it } from 'vitest'

import { revisionFiles } from './diffFiles'

const diff = (from: string, to: string) => `--- ${from}\n+++ ${to}\n@@ -1 +1 @@\n-replicas: 1\n+replicas: 2\n`

describe('revisionFiles', () => {
  it('shows two revisions of one release as one file named by both revisions', () => {
    const [f] = revisionFiles(parse(diff('kubeast/kubeast@3.manifest', 'kubeast/kubeast@2.manifest')))
    expect(f.isRename).toBeFalsy()
    expect([f.oldName, f.newName]).toEqual(['kubeast/kubeast @3 → @2', 'kubeast/kubeast @3 → @2'])
    const [next] = revisionFiles(parse(diff('ns/app@4.manifest', 'ns/app@next.manifest')))
    expect(next.newName).toBe('ns/app @4 → @next')
  })

  it('leaves other names alone', () => {
    const [f] = revisionFiles(parse(diff('ns/a@1.manifest', 'ns/b@2.manifest')))
    expect([f.oldName, f.newName]).toEqual(['ns/a@1.manifest', 'ns/b@2.manifest'])
    const [same] = revisionFiles(parse(diff('values.yaml', 'values.yaml')))
    expect(same.newName).toBe('values.yaml')
  })
})
