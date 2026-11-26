// Modules of monaco-editor that its package exports (`./*.js`) without types, as far as the console reads them.

declare module 'monaco-editor/editor/browser/config/tabFocus.js' {
  export const TabFocus: {
    getTabFocusMode(): boolean
    setTabFocusMode(on: boolean): void
    onDidChangeTabFocus(listener: (on: boolean) => void): { dispose(): void }
  }
}

declare module 'monaco-editor/editor/common/config/editorOptions.js' {
  export const EditorOptions: {
    tabFocusMode: { id: number; defaultValue: boolean; compute(env: { tabFocusMode: boolean }, options: unknown, value: boolean): boolean }
  }
}
