import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { parseNamespaceList, sameNamespaces } from '@/utils/namespaceScope'

// A grant's namespace scope, edited as text: empty = the whole cluster. The
// list is committed on blur or Enter, only when it changed.
export default function NamespaceScopeInput({
  value,
  onCommit,
  disabled,
  testId,
  className,
}: {
  value: string[] | undefined
  onCommit: (namespaces: string[]) => void
  disabled?: boolean
  testId: string
  className?: string
}) {
  const { t } = useTranslation()
  const [text, setText] = useState((value ?? []).join(', '))
  useEffect(() => {
    setText((value ?? []).join(', '))
  }, [value])
  const commit = () => {
    const next = parseNamespaceList(text)
    if (!sameNamespaces(next, value)) onCommit(next)
    else setText(next.join(', '))
  }
  return (
    <input
      data-testid={testId}
      value={text}
      disabled={disabled}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
        }
      }}
      placeholder={t('namespaceScope.placeholder', { defaultValue: 'All namespaces — or list some, comma-separated' })}
      title={t('namespaceScope.hint', { defaultValue: 'Empty = the whole cluster. Up to 50 namespaces; the cluster must bind the role in each (chart auth.impersonation.customRoles).' })}
      className={`rounded-lg border border-slate-600 bg-slate-900/60 px-2 py-1 text-xs text-white placeholder:text-slate-500 focus:border-primary-500 focus:outline-hidden disabled:opacity-50 ${className ?? ''}`}
    />
  )
}
