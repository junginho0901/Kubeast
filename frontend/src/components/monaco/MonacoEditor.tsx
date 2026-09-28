// Monaco served from our own bundle instead of the jsdelivr CDN: the gateway
// CSP is `script-src 'self'`, so the CDN loader never loads. This module is
// only ever imported through `CodeEditor` (React.lazy), so monaco and its
// workers stay out of the initial bundle.
import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import { loader } from '@monaco-editor/react'

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'json') return new jsonWorker()
    if (label === 'typescript' || label === 'javascript') return new tsWorker()
    return new editorWorker()
  },
}

loader.config({ monaco })

export { default } from '@monaco-editor/react'
