import { lazy, Suspense } from 'react'
import { flushSync } from 'react-dom'
import { Trans } from 'react-i18next'
import type { EditorProps, OnChange } from '@monaco-editor/react'
import { useColorMode } from '@/utils/colorMode'

export type { EditorProps, Monaco, OnMount, BeforeMount } from '@monaco-editor/react'

const MonacoEditor = lazy(() => import('./MonacoEditor'))

// The library writes `value` over the editor's text whenever the two differ. A `value` rendered after more keys is the
// text before them, so each edit is rendered at once and `value` is the text again before the next key. A flush event is
// the library's own: it sets a read-only editor's new `value` in an effect, where flushSync renders nothing.
const renderedAtOnce = (onChange: OnChange): OnChange => (text, event) => {
  if (event.isFlush) onChange(text, event)
  else flushSync(() => onChange(text, event))
}

// Drop-in for `@monaco-editor/react`'s Editor that loads monaco on first use. In the light colour mode the dark
// theme becomes Monaco's light one.
export default function CodeEditor(props: EditorProps) {
  const colorMode = useColorMode()
  const theme = colorMode === 'light' && props.theme === 'vs-dark' ? 'vs' : props.theme
  const { value, onChange } = props
  const fallback = props.loading ?? (
    <div className="p-3 text-xs text-slate-400"><Trans i18nKey="common.loadingEditor" defaults="Loading editor..." /></div>
  )
  return (
    <Suspense fallback={fallback}>
      <MonacoEditor {...props} theme={theme} onChange={value !== undefined && onChange ? renderedAtOnce(onChange) : onChange} />
    </Suspense>
  )
}
