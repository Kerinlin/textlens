import { useEffect, useMemo, useState, type JSX, type MouseEvent } from 'react'
import { X } from 'lucide-react'

import { ActionIcon } from '../components/ActionIcon'
import { LUCIDE_ICON_NAMES, isLucideIconName } from '../components/lucideIconRegistry'

const ICON_PAGE_SIZE = 120

interface ActionIconPickerProps {
  value: string
  onChange: (value: string) => void
}

export function ActionIconPicker({ value, onChange }: ActionIconPickerProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const valid = isLucideIconName(value)

  return (
    <>
      <button
        className={`icon-picker-trigger ${valid ? '' : 'icon-picker-trigger--invalid'}`}
        type="button"
        aria-label="选择图标"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <ActionIcon name={value} size={18} />
      </button>
      {open && (
        <IconPickerDialog
          value={value}
          onCancel={() => setOpen(false)}
          onSelect={(name) => {
            onChange(name)
            setOpen(false)
          }}
        />
      )}
    </>
  )
}

function IconPickerDialog({
  value,
  onCancel,
  onSelect
}: {
  value: string
  onCancel: () => void
  onSelect: (value: string) => void
}): JSX.Element {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(value)
  const [visibleCount, setVisibleCount] = useState(ICON_PAGE_SIZE)
  const needle = query.trim().toLowerCase()
  const matches = useMemo(
    () => (needle ? LUCIDE_ICON_NAMES.filter((name) => name.includes(needle)) : LUCIDE_ICON_NAMES),
    [needle]
  )
  const visible = matches.slice(0, visibleCount)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onCancel])

  return (
    <div
      className="dialog-backdrop dialog-backdrop--front"
      role="presentation"
      onMouseDown={(event: MouseEvent<HTMLDivElement>) => {
        event.stopPropagation()
        if (event.target === event.currentTarget) onCancel()
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <section
        className="dialog-card icon-picker-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="icon-picker-title"
      >
        <header className="dialog-header">
          <h2 id="icon-picker-title">选择图标</h2>
          <button className="icon-button" type="button" aria-label="关闭图标选择" onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onCancel()
          }}>
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <div className="icon-picker-dialog__body">
          <input
            className="control"
            value={query}
            placeholder="搜索"
            aria-label="搜索图标"
            spellCheck={false}
            onChange={(event) => {
              setQuery(event.target.value)
              setVisibleCount(ICON_PAGE_SIZE)
            }}
          />
          <div className="icon-picker-grid" role="listbox" aria-label="图标">
            {visible.map((name) => (
              <button
                className={selected === name ? 'is-selected' : ''}
                type="button"
                role="option"
                title={name}
                aria-label={name}
                aria-selected={selected === name}
                key={name}
                onClick={() => setSelected(name)}
              >
                <ActionIcon name={name} size={18} />
              </button>
            ))}
          </div>
          {visibleCount < matches.length && (
            <button
              className="button button--quiet"
              type="button"
              onClick={() => setVisibleCount((count) => count + ICON_PAGE_SIZE)}
            >
              更多
            </button>
          )}
        </div>
        <footer className="dialog-actions icon-picker-dialog__actions">
          <button className="button button--primary" type="button" disabled={!isLucideIconName(selected)} onClick={() => onSelect(selected)}>
            确定
          </button>
        </footer>
      </section>
    </div>
  )
}
