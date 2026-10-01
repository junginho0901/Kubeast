// Monaco served from our own bundle instead of the jsdelivr CDN: the gateway
// CSP is `script-src 'self'`, so the CDN loader never loads. This module is
// only ever imported through `CodeEditor` (React.lazy), so monaco and its
// workers stay out of the initial bundle.
import * as monaco from 'monaco-editor'
// monaco-editor >= 0.57 ships an `exports` map ("./*.js" -> "./esm/vs/*.js"), so
// the workers are imported by their subpath under esm/vs, with the extension.
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import jsonWorker from 'monaco-editor/language/json/json.worker.js?worker'
import tsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker'
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
