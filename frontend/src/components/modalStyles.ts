// Footer buttons of ModalFrame windows: one height and shape for every
// create, edit and confirm window.
export const modalButton = {
  cancel: 'h-9 px-4 text-sm rounded-lg border border-control text-slate-300 hover:text-ink hover:bg-slate-700 disabled:opacity-50 inline-flex items-center justify-center gap-2 whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-400 hit-area-40',
  primary: 'h-9 px-4 text-sm rounded-lg bg-primary-600 hover:bg-primary-700 text-white disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center justify-center gap-2 whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-400',
  danger: 'h-9 px-4 text-sm rounded-lg bg-red-600 hover:bg-red-700 text-white disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center justify-center gap-2 whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-400',
}

// Height of the YAML editor in a create window: as tall as the text (12px
// font ≈ 18px a line, plus padding), between a floor that keeps it usable
// and a cap that keeps the window on a 900px screen (re-QA #53 / #58 — the
// fixed 460px left most of it empty for a short example). On a lower screen
// the window shortens it (ResourceYamlCreateDialog).
export const YAML_EDITOR_MIN = 240
export const YAML_EDITOR_MAX = 560

export function yamlEditorHeight(text: string): number {
  const lines = text.split('\n').length
  return Math.min(YAML_EDITOR_MAX, Math.max(YAML_EDITOR_MIN, lines * 18 + 24))
}
