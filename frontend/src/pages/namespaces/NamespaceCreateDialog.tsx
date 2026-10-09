import { useState } from 'react'
import { ModalFrame } from '@/components/ModalFrame'
import { modalButton } from '@/components/modalStyles'
import { api } from '@/services/api'
import { isValidNsName } from './namespaceHelpers'

interface Props {
  onClose: () => void
  onCreated: () => void
  tr: (key: string, fallback: string, options?: Record<string, any>) => string
}

export default function NamespaceCreateDialog({ onClose, onCreated, tr }: Props) {
  const [newNsName, setNewNsName] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const handleCreate = async () => {
    if (!isValidNsName(newNsName) || isCreating) return
    setIsCreating(true)
    setCreateError(null)
    try {
      await api.createNamespace(newNsName)
      onCreated()
      onClose()
    } catch (err: any) {
      const detail = err?.response?.data?.detail || err?.message || ''
      if (detail.includes('already exists')) {
        setCreateError(tr('namespaces.create.exists', 'Namespace already exists.'))
      } else {
        setCreateError(tr('namespaces.create.error', 'Failed to create namespace.'))
      }
    } finally {
      setIsCreating(false)
    }
  }

  return (
    <ModalFrame
      size="sm"
      title={tr('namespaces.create.title', 'Create New Namespace')}
      onClose={onClose}
      busy={isCreating}
      testId="namespace-create-dialog"
      footer={
        <>
          <button type="button" onClick={onClose} className={modalButton.cancel} disabled={isCreating}>
            {tr('namespaces.create.cancel', 'Cancel')}
          </button>
          <button type="button" onClick={handleCreate} disabled={!isValidNsName(newNsName) || isCreating} className={modalButton.primary}>
            {isCreating
              ? tr('namespaces.create.creating', 'Creating...')
              : tr('namespaces.create.submit', 'Create')}
          </button>
        </>
      }
    >
      <input
        type="text"
        value={newNsName}
        onChange={(e) => {
          setNewNsName(e.target.value.toLowerCase())
          setCreateError(null)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            handleCreate()
          }
        }}
        placeholder={tr('namespaces.create.namePlaceholder', 'Enter namespace name')}
        className="w-full px-3 py-2 bg-slate-800 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-hidden focus:ring-2 focus:ring-primary-500"
        autoFocus
      />
      <p className="mt-1 text-xs text-slate-400">
        {tr('namespaces.create.nameHelp', 'Lowercase, numbers, and hyphens only (max 63 chars)')}
      </p>
      {newNsName && !isValidNsName(newNsName) && (
        <p className="mt-1 text-xs text-red-400">
          {newNsName.length > 63
            ? tr('namespaces.create.nameTooLong', 'Name must be 63 characters or less.')
            : tr('namespaces.create.nameInvalid', 'Invalid name.')}
        </p>
      )}
      {createError && <p className="mt-1 text-xs text-red-400">{createError}</p>}
    </ModalFrame>
  )
}
