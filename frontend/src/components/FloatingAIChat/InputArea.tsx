import { useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Send, Square } from 'lucide-react'
import { useAutoGrowTextarea, useChatTextareaKeys } from '@/hooks/useChatTextarea'

interface InputAreaProps {
  onSubmit: (message: string) => void
  onStop: () => void
  isStreaming: boolean
  disabled?: boolean
  /** 대화가 있으면 입력칸 왼쪽에 "새 대화" — 닫기(X)와 떨어진 자리 */
  onNewChat?: () => void
}

/**
 * 질문 입력 영역. 엔터로 전송, Shift+Enter 줄바꿈, 스트리밍 중엔 중지 버튼 표시.
 */
export function InputArea({ onSubmit, onStop, isStreaming, disabled, onNewChat }: InputAreaProps) {
  const { t } = useTranslation()
  const [value, setValue] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  useAutoGrowTextarea(ref, value, 128)

  const handleSubmit = (e?: FormEvent) => {
    e?.preventDefault()
    const trimmed = value.trim()
    if (!trimmed || isStreaming) return
    onSubmit(trimmed)
    setValue('')
  }

  const keys = useChatTextareaKeys(ref, setValue, () => handleSubmit())

  return (
    <form
      onSubmit={handleSubmit}
      className="flex items-end gap-2 border-t border-slate-700 bg-slate-900/60 px-3 py-2"
    >
      {onNewChat && (
        <button
          type="button"
          data-testid="floating-new-chat"
          onClick={() => {
            onNewChat()
            ref.current?.focus()
          }}
          disabled={isStreaming}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-slate-800 hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
          aria-label={t('aiChat.newChat', { defaultValue: 'New Chat' })}
          title={t('aiChat.newChat', { defaultValue: 'New Chat' })}
        >
          <Plus className="h-4 w-4" />
        </button>
      )}
      <textarea
        ref={ref}
        data-testid="floating-chat-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={keys.onKeyDown}
        onCompositionEnd={keys.onCompositionEnd}
        placeholder={t('floatingChat.inputPlaceholder', { defaultValue: 'Ask about this page...' })}
        rows={1}
        disabled={disabled}
        className="min-h-9 flex-1 resize-none rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-primary-500 focus:outline-hidden focus:ring-1 focus:ring-primary-500 disabled:opacity-50"
      />
      {isStreaming ? (
        <button
          type="button"
          onClick={onStop}
          className="flex h-9 w-9 items-center justify-center rounded-md bg-red-600 text-white hover:bg-red-500"
          aria-label={t('floatingChat.stopAriaLabel', { defaultValue: 'Stop' })}
          title={t('floatingChat.stopAriaLabel', { defaultValue: 'Stop' })}
        >
          <Square className="h-4 w-4" />
        </button>
      ) : (
        <button
          type="submit"
          disabled={disabled || value.trim().length === 0}
          className="flex h-9 w-9 items-center justify-center rounded-md bg-primary-600 text-white hover:bg-primary-500 disabled:cursor-not-allowed disabled:opacity-40"
          aria-label={t('floatingChat.sendAriaLabel', { defaultValue: 'Send' })}
          title={t('floatingChat.sendAriaLabel', { defaultValue: 'Send' })}
        >
          <Send className="h-4 w-4" />
        </button>
      )}
    </form>
  )
}
