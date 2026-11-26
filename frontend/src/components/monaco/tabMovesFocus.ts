import type { editor as MonacoEditor } from 'monaco-editor'
import { TabFocus } from 'monaco-editor/editor/browser/config/tabFocus.js'

type Editor = Pick<MonacoEditor.ICodeEditor, 'getOption' | 'onDidChangeConfiguration' | 'onDidDispose'>

/**
 * Tells `tell` whether Tab moves the focus out of `editor`, now and on each change until the editor is disposed. Monaco
 * decides it as its `editorTabMovesFocus` context key does: the editor's `tabFocusMode` option, or Monaco's Tab switch
 * (`editor.action.toggleTabFocusMode`, Ctrl+M, Ctrl+Shift+M on a Mac), one flag for every editor of the page that the
 * option and its change event do not report.
 */
export function followTabMovesFocus(editor: Editor, option: MonacoEditor.EditorOption.tabFocusMode, tell: (moves: boolean) => void): void {
  const read = () => tell(editor.getOption(option) || TabFocus.getTabFocusMode())
  read()
  const switched = TabFocus.onDidChangeTabFocus(read)
  editor.onDidChangeConfiguration((e) => {
    if (e.hasChanged(option)) read()
  })
  editor.onDidDispose(() => switched.dispose())
}
