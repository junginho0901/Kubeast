import type { DiffFile } from 'diff2html/lib/types'

const REVISION_LABEL = /^(.*)@([^@/]+)\.manifest$/

// The server labels the two sides of a release diff "<ns>/<name>@<rev>.manifest" (rev or "next"). diff2html marks
// two different names as a rename; they are revisions of one release, shown as one file "<ns>/<name> @3 → @2".
export function revisionFiles(files: DiffFile[]): DiffFile[] {
  return files.map((f) => {
    const from = REVISION_LABEL.exec(f.oldName)
    const to = REVISION_LABEL.exec(f.newName)
    if (!from || !to || from[1] !== to[1]) return f
    const label = `${from[1]} @${from[2]} → @${to[2]}`
    return { ...f, isRename: false, oldName: label, newName: label }
  })
}
