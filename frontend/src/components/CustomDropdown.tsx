import { useEffect, useRef, useState } from 'react'
import { ChevronDown, CheckCircle } from 'lucide-react'

export interface DropdownOption {
  value: string
  label: string
  /** Optional icon or emoji displayed before the label */
  icon?: string
  /** Extra info displayed after the label (dimmed) */
  hint?: string
  /** If true the option is rendered with dimmed style */
  disabled?: boolean
  /** Optional test id, applied to this option's button */
  testId?: string
}

interface CustomDropdownProps {
  options: DropdownOption[]
  value: string
  onChange: (value: string) => void
  placeholder?: string
  /** Optional label above the dropdown */
  label?: string
  className?: string
  disabled?: boolean
  /** Optional test id, applied to the trigger button */
  testId?: string
}

/**
 * CustomDropdown — matches the style used in ClusterView / Monitoring / Pods
 * (bg-slate-700 trigger, green CheckCircle on selected item)
 */
export default function CustomDropdown({
  options,
  value,
  onChange,
  placeholder = 'Select…',
  label,
  className = '',
  disabled = false,
  testId,
}: CustomDropdownProps) {
  const [isOpen, setIsOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // close on outside click
  useEffect(() => {
    if (!isOpen) return
    const handle = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [isOpen])

  const selected = options.find((o) => o.value === value)

  return (
    <div className={`relative ${className}`} ref={containerRef}>
      {label && (
        <label className="block text-xs font-semibold text-slate-400 mb-1">{label}</label>
      )}

      {/* trigger — same style as ClusterView namespace selector */}
      <button
        type="button"
        data-testid={testId}
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        className="w-full h-10 px-4 bg-slate-700 hover:bg-slate-600 text-white rounded-lg border border-slate-600 focus:outline-none focus:border-primary-500 transition-colors flex items-center gap-2 justify-between disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <span className="flex items-center gap-2 text-sm font-medium truncate">
          {selected?.icon && <span className="text-base flex-shrink-0">{selected.icon}</span>}
          <span className="truncate">{selected?.label ?? placeholder}</span>
          {selected?.hint && (
            <span className="text-[10px] text-slate-400 flex-shrink-0">({selected.hint})</span>
          )}
        </span>
        <ChevronDown
          className={`w-4 h-4 text-slate-400 flex-shrink-0 transition-transform ${
            isOpen ? 'rotate-180' : ''
          }`}
        />
      </button>

      {/* dropdown panel */}
      {isOpen && (
        <div className="absolute top-full left-0 mt-2 w-full bg-slate-700 border border-slate-600 rounded-lg shadow-xl z-[200] max-h-[260px] overflow-y-auto">
          {options.map((opt) => {
            const isSelected = opt.value === value
            return (
              <button
                key={opt.value}
                type="button"
                data-testid={opt.testId}
                onClick={() => {
                  if (!opt.disabled) {
                    onChange(opt.value)
                    setIsOpen(false)
                  }
                }}
                className={`w-full px-4 py-2.5 text-left text-sm text-white hover:bg-slate-600 transition-colors flex items-center gap-2 first:rounded-t-lg last:rounded-b-lg ${
                  opt.disabled ? 'opacity-40 cursor-not-allowed' : ''
                }`}
              >
                {isSelected && (
                  <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0" />
                )}
                {opt.icon && !isSelected && (
                  <span className="text-base flex-shrink-0">{opt.icon}</span>
                )}
                <span className={isSelected ? 'font-medium' : ''}>{opt.label}</span>
                {opt.hint && (
                  <span className="ml-auto text-[10px] text-slate-400 flex-shrink-0">
                    {opt.hint}
                  </span>
                )}
              </button>
            )
          })}
          {options.length === 0 && (
            <div className="px-4 py-2.5 text-sm text-slate-400">No options</div>
          )}
        </div>
      )}
    </div>
  )
}
