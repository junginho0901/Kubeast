import { lazy, Suspense } from 'react'
import { Trans } from 'react-i18next'
import type { EditorProps } from '@monaco-editor/react'

export type { EditorProps, Monaco, OnMount, BeforeMount } from '@monaco-editor/react'

const MonacoEditor = lazy(() => import('./MonacoEditor'))

// Drop-in for `@monaco-editor/react`'s Editor that loads monaco on first use.
export default function CodeEditor(props: EditorProps) {
  const fallback = props.loading ?? (
    <div className="p-3 text-xs text-slate-400"><Trans i18nKey="common.loadingEditor" defaults="Loading editor..." /></div>
  )
  return (
    <Suspense fallback={fallback}>
      <MonacoEditor {...props} />
    </Suspense>
  )
}
