import { loader } from '@monaco-editor/react'
import { useState, type ReactNode } from 'react'

const MONACO_CDN = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.47.0/min/vs'

export function MonacoEditorLoaderInitializer({
  children,
}: {
  children: ReactNode
}) {
  useState(() => {
    loader.config({
      paths: {
        vs: MONACO_CDN,
      },
    })
    return true
  })

  return <>{children}</>
}
