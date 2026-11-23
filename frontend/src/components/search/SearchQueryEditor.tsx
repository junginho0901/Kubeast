import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { X, Loader2 } from 'lucide-react'
import type * as MonacoApi from 'monaco-editor'
import MonacoEditor, { type Monaco } from '@/components/monaco/CodeEditor'
import { generateGlobalVarDeclarations } from './inferTypes'
import { useColorMode } from '@/utils/colorMode'

// monaco-editor 0.55 moved the TypeScript defaults to the top-level `typescript`; `languages.typescript` is no longer
// set, and without these options the box offers the browser's globals (TextTrackCue) and none of the objects' fields.
const typescriptOf = (m: Monaco) => (m as unknown as typeof MonacoApi).typescript

interface Props {
  value: string
  onChange: (v: string) => void
  onClear: () => void
  isSearching: boolean
  resultCount: number | null
  totalCount: number
  searchTimeMs: number | null
  items: Record<string, unknown>[]
}

export default function SearchQueryEditor({
  value,
  onChange,
  onClear,
  isSearching,
  resultCount,
  totalCount,
  searchTimeMs,
  items,
}: Props) {
  const { t } = useTranslation()
  const [focused, setFocused] = useState(false)
  const colorMode = useColorMode()
  // Set from onMount: monaco is loaded lazily with the editor, so there is no
  // instance to read before it mounts.
  const [monaco, setMonaco] = useState<Monaco | null>(null)

  const typeDefinition = useMemo(() => {
    if (items.length === 0) return ''
    return generateGlobalVarDeclarations(items as Record<string, any>[], 1000)
  }, [items])

  // The fields of the objects read now, none when nothing is read. The compiler options are set once in beforeMount:
  // setting them again restarts the language worker.
  useEffect(() => {
    if (!monaco) return
    typescriptOf(monaco).javascriptDefaults.setExtraLibs(
      typeDefinition ? [{ content: typeDefinition, filePath: 'globalTypes.d.ts' }] : [],
    )
  }, [monaco, typeDefinition])

  function handleEditorWillMount(m: Monaco) {
    // vs-dark paints an opaque #1e1e1e box inside the rounded field and over the
    // placeholder; these themes keep the field's own background.
    for (const [name, base] of [['kubeast-search', 'vs-dark'], ['kubeast-search-light', 'vs']] as const) {
      m.editor.defineTheme(name, {
        base,
        inherit: true,
        rules: [],
        colors: { 'editor.background': '#00000000', 'editorGutter.background': '#00000000' },
      })
    }
    // The ECMAScript library alone, for the methods after a field (`.startsWith`): no browser global is a word of an expression
    const ts = typescriptOf(m)
    ts.javascriptDefaults.setCompilerOptions({
      target: ts.ScriptTarget.ESNext,
      noLib: false,
      allowNonTsExtensions: true,
      lib: ['esnext'],
    })
  }

  return (
    <div className="space-y-2">
      <div
        className={`relative flex items-center rounded-xl border transition-colors ${
          focused ? 'border-primary-500/50 bg-slate-800/80' : 'border-slate-600 bg-slate-800/50'
        }`}
      >
        {!focused && !value && (
          <div className="absolute left-4 text-slate-500 text-sm pointer-events-none">
            {t('advancedSearch.queryPlaceholder', 'Search resources by JavaScript expression...')}
          </div>
        )}
        <div className="flex-1 py-1" onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}>
          <MonacoEditor
            height="28px"
            language="javascript"
            theme={colorMode === 'light' ? 'kubeast-search-light' : 'kubeast-search'}
            value={value}
            beforeMount={handleEditorWillMount}
            onChange={v => onChange(v ?? '')}
            onMount={(editor, m) => {
              setMonaco(m)
              editor.onDidContentSizeChange(size => {
                const node = editor.getDomNode()
                if (node) node.style.height = size.contentHeight + 'px'
              })
            }}
            options={{
              minimap: { enabled: false },
              scrollbar: { vertical: 'hidden', horizontal: 'auto' },
              lineNumbers: 'off',
              scrollBeyondLastLine: false,
              wordWrap: 'off' as const,
              folding: false,
              glyphMargin: false,
              lineDecorationsWidth: 12,
              renderLineHighlight: 'none' as const,
              hideCursorInOverviewRuler: true,
              overviewRulerBorder: false,
              automaticLayout: true,
              fontSize: 14,
              fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
              padding: { top: 6, bottom: 6 },
              quickSuggestions: true,
              suggestOnTriggerCharacters: true,
            }}
          />
        </div>
        {value && (
          <button
            onClick={onClear}
            className="p-2 mr-1 text-slate-400 hover:text-ink transition-colors"
            aria-label={t('common.clearSearch', 'Clear the search')}
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      <div className="flex items-center gap-3 text-xs text-slate-500 h-5 ml-1">
        {isSearching && (
          <span className="flex items-center gap-1.5 text-primary-400">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            {t('advancedSearch.searching', 'Searching...')}
          </span>
        )}
        {!isSearching && resultCount !== null && value.trim() && (
          <>
            <span className="text-slate-400">
              {t('advancedSearch.resultsCount', '{{count}} results', { count: resultCount })}
              {totalCount > 0 && (
                <span className="text-slate-500">
                  {' '}{t('advancedSearch.outOf', '(out of {{total}})', { total: totalCount })}
                </span>
              )}
            </span>
            {searchTimeMs !== null && (
              <span className="text-slate-500">
                {searchTimeMs.toFixed(0)}ms
              </span>
            )}
          </>
        )}
      </div>
    </div>
  )
}
