import { useEffect, useState } from 'react'

const STORAGE_KEY = 'nodeShellSettings'

export type NodeShellSettings = {
  isEnabled: boolean
  namespace: string
  linuxImage: string
}

const DEFAULTS: NodeShellSettings = {
  isEnabled: true,
  namespace: 'default',
  linuxImage: 'docker.io/library/busybox:latest',
}

export const loadNodeShellSettings = (): NodeShellSettings => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULTS
    const parsed = JSON.parse(raw)
    return {
      isEnabled: typeof parsed?.isEnabled === 'boolean' ? parsed.isEnabled : DEFAULTS.isEnabled,
      namespace: parsed?.namespace || DEFAULTS.namespace,
      linuxImage: parsed?.linuxImage || DEFAULTS.linuxImage,
    }
  } catch {
    return DEFAULTS
  }
}

export const saveNodeShellSettings = (next: NodeShellSettings) => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  window.dispatchEvent(new Event('node-shell-settings'))
}

export const useNodeShellSettings = () => {
  const [settings, setSettings] = useState<NodeShellSettings>(loadNodeShellSettings())

  useEffect(() => {
    const handler = () => setSettings(loadNodeShellSettings())
    window.addEventListener('node-shell-settings', handler)
    window.addEventListener('storage', handler)
    return () => {
      window.removeEventListener('node-shell-settings', handler)
      window.removeEventListener('storage', handler)
    }
  }, [])

  return settings
}
