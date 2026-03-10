import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { X, Loader2 } from 'lucide-react'
import MonacoEditor, { useMonaco } from '@monaco-editor/react'
import type { Monaco } from '@monaco-editor/react'
import { generateGlobalVarDeclarations } from './inferTypes'

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
  const monaco = useMonaco()

  const typeDefinition = useMemo(() => {
    if (items.length === 0) return ''
    return generateGlobalVarDeclarations(items as Record<string, any>[], 1000)
  }, [items])

  useEffect(() => {
    if (monaco && typeDefinition) {
      const ts = (monaco.languages as any).typescript
      if (!ts) return
      ts.javascriptDefaults.setCompilerOptions({
        target: ts.ScriptTarget.ESNext,
        noLib: false,
        allowNonTsExtensions: true,
        lib: ['esnext'],
      })
      ts.javascriptDefaults.setExtraLibs([
        { content: typeDefinition, filePath: 'globalTypes.d.ts' },
      ])
    }
  }, [monaco, typeDefinition])

  function handleEditorWillMount(m: Monaco) {
    const ts = (m.languages as any).typescript
    if (!ts) return
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
          focused ? 'border-sky-500/50 bg-slate-800/80' : 'border-slate-600 bg-slate-800/50'
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
            theme="vs-dark"
            value={value}
            beforeMount={handleEditorWillMount}
            onChange={v => onChange(v ?? '')}
            onMount={editor => {
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
            className="p-2 mr-1 text-slate-400 hover:text-white transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      <div className="flex items-center gap-3 text-xs text-slate-500 h-5 ml-1">
        {isSearching && (
          <span className="flex items-center gap-1.5 text-sky-400">
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
              <span className="text-slate-600">
                {searchTimeMs.toFixed(0)}ms
              </span>
            )}
          </>
        )}
      </div>
    </div>
  )
}
