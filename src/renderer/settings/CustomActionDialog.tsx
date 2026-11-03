import { useEffect, useMemo, useRef, useState, type FormEvent, type JSX } from 'react'
import { Braces, RotateCcw, X } from 'lucide-react'

import {
  DEFAULT_ACTION_PROMPTS,
  DEFAULT_SEARCH_ENGINE_ID,
  DEFAULT_SEARCH_ENGINES,
  TEXT_PLACEHOLDER,
  THINKING_LEVEL_LABELS,
  aiActionKindSchema,
  clampThinkingMode,
  effectiveThinkingLevels,
  modelSupportsThinkingOff,
  type ActionDefinition,
  type ActionKind,
  type PublicProviderSettings,
  type SearchEngineId,
  type ThinkingMode
} from '../../shared'
import { isLucideIconName } from '../components/lucideIconRegistry'
import { ActionIconPicker } from './ActionIconPicker'

const ACTION_KIND_NAMES: Readonly<Record<ActionKind, string>> = {
  copy: '复制',
  search: '搜索 / 打开网址',
  translate: '翻译',
  summary: '总结',
  explain: '解释',
  refine: '润色',
  ask: '问AI',
  extract: '图片处理',
  custom: '自定义 AI'
}

function isAiKind(kind: ActionKind): boolean {
  return aiActionKindSchema.safeParse(kind).success
}

function defaultPrompt(kind: ActionKind): string {
  if (
    kind === 'translate' ||
    kind === 'summary' ||
    kind === 'explain' ||
    kind === 'refine' ||
    kind === 'ask' ||
    kind === 'extract'
  ) {
    return DEFAULT_ACTION_PROMPTS[kind]
  }
  return DEFAULT_ACTION_PROMPTS.custom
}

export function promptAfterKindChange(
  currentKind: ActionKind,
  nextKind: ActionKind,
  prompt: string
): string {
  if (!isAiKind(nextKind)) return prompt

  const cleanPrompt = prompt.trim()
  const currentDefault = defaultPrompt(currentKind).trim()
  return !cleanPrompt || cleanPrompt === currentDefault ? defaultPrompt(nextKind) : prompt
}

export interface ActionEditorValue {
  name: string
  icon: string
  kind: ActionKind
  prompt?: string
  providerId?: string
  modelId?: string
  thinkingMode?: ThinkingMode
  searchEngineId?: SearchEngineId
}

interface ModelRoute {
  providerId: string
  modelId: string
}

function modelRouteValue(route: ModelRoute): string {
  return JSON.stringify([route.providerId, route.modelId])
}

function parseModelRoute(value: string): ModelRoute | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as unknown
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string'
    ) {
      return { providerId: parsed[0], modelId: parsed[1] }
    }
  } catch {
    /* ignore */
  }
  return null
}

interface ModelChoice extends ModelRoute {
  value: string
  providerName: string
  modelName: string
  thinkingLevels: ReturnType<typeof effectiveThinkingLevels>
}

export function CustomActionDialog({
  action,
  providers,
  onCancel,
  onSave
}: {
  action: ActionDefinition | null
  providers: readonly PublicProviderSettings[]
  onCancel: () => void
  onSave: (value: ActionEditorValue) => void
}): JSX.Element {
  const initialAi = action && 'prompt' in action ? action : null
  const initialSearchEngineId =
    action && action.kind === 'search' && 'searchEngineId' in action
      ? action.searchEngineId
      : DEFAULT_SEARCH_ENGINE_ID
  const [name, setName] = useState(action?.name ?? '')
  const [icon, setIcon] = useState(action?.icon ?? 'sparkles')
  const [kind, setKind] = useState<ActionKind>(action?.kind ?? 'custom')
  const [providerId, setProviderId] = useState(initialAi?.providerId ?? '')
  const [modelId, setModelId] = useState(initialAi?.modelId ?? '')
  const [thinkingMode, setThinkingMode] = useState<ThinkingMode>(initialAi?.thinkingMode ?? 'off')
  const [searchEngineId, setSearchEngineId] = useState<SearchEngineId>(initialSearchEngineId)
  const [prompt, setPrompt] = useState(initialAi?.prompt ?? DEFAULT_ACTION_PROMPTS.custom)
  const [error, setError] = useState('')
  const nameRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLElement>(null)

  const enabledProviders = useMemo(
    () => providers.filter((provider) => provider.enabled !== false),
    [providers]
  )

  const modelGroups = useMemo(() => {
    return enabledProviders
      .filter((provider) => provider.models.length > 0)
      .map((provider) => ({
        id: provider.id,
        name: provider.name,
        keyConfigured: provider.keyConfigured,
        choices: provider.models.map<ModelChoice>((model) => ({
          providerId: provider.id,
          modelId: model.id,
          providerName: provider.name,
          modelName: model.name,
          thinkingLevels: effectiveThinkingLevels(model.id, model.thinkingLevels),
          value: modelRouteValue({ providerId: provider.id, modelId: model.id })
        }))
      }))
  }, [enabledProviders])

  const modelChoices = useMemo(
    () => modelGroups.flatMap((group) => group.choices),
    [modelGroups]
  )

  const selectedChoice = useMemo(() => {
    if (!providerId || !modelId) return null
    return modelChoices.find(
      (choice) => choice.providerId === providerId && choice.modelId === modelId
    ) ?? null
  }, [modelChoices, modelId, providerId])

  const modelSelectValue = providerId && modelId
    ? modelRouteValue({ providerId, modelId })
    : ''

  const thinkingLevels = selectedChoice?.thinkingLevels ?? []
  const showThinkingOff = modelSupportsThinkingOff(thinkingLevels)

  useEffect(() => {
    nameRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel()
      if (event.key !== 'Tab') return

      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])'
      )
      if (!focusable?.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!first || !last) return
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onCancel])

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const cleanName = name.trim()
    const cleanPrompt = prompt.trim()
    if (!cleanName) return setError('请输入动作名称')
    if (cleanName.length > 40) return setError('动作名称不能超过 40 个字符')
    if (!isLucideIconName(icon)) return setError('请选择有效的 Lucide 图标')

    if (isAiKind(kind)) {
      // Image-input actions receive the capture as a multimodal part, so
      // their prompt has no text placeholder to substitute.
      if (kind !== 'extract' && !cleanPrompt.includes(TEXT_PLACEHOLDER)) {
        return setError(`提示词必须包含 ${TEXT_PLACEHOLDER}`)
      }
      if (cleanPrompt.length > 10_000) return setError('提示词不能超过 10,000 个字符')
      onSave({
        name: cleanName,
        icon,
        kind,
        prompt: cleanPrompt,
        providerId,
        modelId,
        thinkingMode: clampThinkingMode(thinkingMode, thinkingLevels)
      })
      return
    }
    if (kind === 'search') {
      onSave({ name: cleanName, icon, kind, searchEngineId })
      return
    }
    onSave({ name: cleanName, icon, kind })
  }

  const insertPlaceholder = (): void => {
    const textarea = document.getElementById('action-prompt') as HTMLTextAreaElement | null
    if (!textarea) return setPrompt((value) => `${value}${TEXT_PLACEHOLDER}`)
    const start = textarea.selectionStart
    const end = textarea.selectionEnd
    setPrompt((value) => `${value.slice(0, start)}${TEXT_PLACEHOLDER}${value.slice(end)}`)
    requestAnimationFrame(() => {
      const position = start + TEXT_PLACEHOLDER.length
      textarea.focus()
      textarea.setSelectionRange(position, position)
    })
  }

  const changeKind = (next: ActionKind): void => {
    setPrompt((current) => promptAfterKindChange(kind, next, current))
    setKind(next)
    setError('')
  }

  const changeModelRoute = (value: string): void => {
    const route = parseModelRoute(value)
    if (!route) {
      setProviderId('')
      setModelId('')
      setThinkingMode('off')
      return
    }
    const choice = modelChoices.find(
      (item) => item.providerId === route.providerId && item.modelId === route.modelId
    )
    setProviderId(route.providerId)
    setModelId(route.modelId)
    setThinkingMode((current) =>
      clampThinkingMode(current, choice?.thinkingLevels ?? [])
    )
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onCancel()
    }}>
      <section
        ref={dialogRef}
        className="dialog-card dialog-card--action"
        role="dialog"
        aria-modal="true"
        aria-labelledby="action-dialog-title"
      >
        <header className="dialog-header">
          <div>
            <h2 id="action-dialog-title">{action ? '编辑动作' : '添加动作'}</h2>
            <p>
              {kind === 'search'
                ? '搜索动作可选择默认搜索引擎；选中网址时仍会直接打开。'
                : kind === 'extract'
                  ? '图片处理动作作用于截图：截图作为图片随提示词发给模型，结果出现在截图工具栏触发的结果窗口。'
                  : isAiKind(kind)
                    ? '同一种动作可以添加多次，并分别绑定服务商、模型和提示词。'
                    : '可调整名称、类型与图标；本地动作无需配置模型。'}
            </p>
          </div>
          <button className="icon-button" type="button" aria-label="关闭" onClick={onCancel}>
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <form className="dialog-form" onSubmit={submit}>
          <div className="field">
            <span className="field__label">图标</span>
            <div className="icon-field">
              <ActionIconPicker value={icon} onChange={(value) => {
                setIcon(value)
                setError('')
              }} />
              <span className="icon-field__hint">点击更换图标</span>
            </div>
          </div>
          <div className="dialog-form-grid">
            <label className="field">
              <span className="field__label">动作名称</span>
              <input
                ref={nameRef}
                className="control"
                value={name}
                maxLength={40}
                placeholder="例如：翻译成日语"
                onChange={(event) => {
                  setName(event.target.value)
                  setError('')
                }}
              />
            </label>
            <label className="field">
              <span className="field__label">动作类型</span>
              <select
                className="control"
                value={kind}
                onChange={(event) => changeKind(event.target.value as ActionKind)}
              >
                {Object.entries(ACTION_KIND_NAMES).map(([value, label]) => (
                  <option value={value} key={value}>{label}</option>
                ))}
              </select>
            </label>
          </div>

          {kind === 'search' && (
            <label className="field">
              <span className="field__label">默认搜索引擎</span>
              <select
                className="control"
                value={searchEngineId}
                onChange={(event) => {
                  setSearchEngineId(event.target.value as SearchEngineId)
                  setError('')
                }}
              >
                {DEFAULT_SEARCH_ENGINES.map((engine) => (
                  <option value={engine.id} key={engine.id}>{engine.name}</option>
                ))}
              </select>
              <span className="field__hint">划词搜索普通文字时使用该引擎；选中网址、域名或 IP 时直接打开。</span>
            </label>
          )}

          {isAiKind(kind) && (
            <>
              <div className="dialog-form-grid dialog-form-grid--model">
                <label className="field">
                  <span className="field__label">模型</span>
                  <select
                    className="control"
                    aria-label="模型"
                    value={modelSelectValue}
                    onChange={(event) => changeModelRoute(event.target.value)}
                  >
                    <option value="">尚未选择</option>
                    {modelGroups.map((group) => (
                      <optgroup
                        key={group.id}
                        label={group.keyConfigured ? group.name : `${group.name}（未配置密钥）`}
                      >
                        {group.choices.map((choice) => (
                          <option key={choice.value} value={choice.value}>
                            {choice.modelName}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </label>

                {thinkingLevels.length > 0 && (
                  <label className="field">
                    <span className="field__label">思考强度</span>
                    <select
                      className="control"
                      aria-label="思考强度"
                      value={thinkingMode}
                      onChange={(event) => setThinkingMode(event.target.value as ThinkingMode)}
                    >
                      {showThinkingOff && (
                        <option value="off">关闭思考（更快首字）</option>
                      )}
                      {thinkingLevels.map((level) => (
                        <option key={level} value={level}>
                          {THINKING_LEVEL_LABELS[level]}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>

              <label className="field">
                <span className="field__label dialog-prompt-label">
                  提示词
                  <span className="dialog-prompt-tools">
                    <button
                      className="prompt-reset-button"
                      type="button"
                      aria-label="恢复默认提示词"
                      disabled={prompt.trim() === defaultPrompt(kind).trim()}
                      onClick={() => {
                        setPrompt(defaultPrompt(kind))
                        setError('')
                      }}
                    >
                      <RotateCcw size={13} aria-hidden="true" />
                      恢复默认提示词
                    </button>
                    {kind !== 'extract' && (
                      <button className="placeholder-button" type="button" onClick={insertPlaceholder}>
                        <Braces size={13} aria-hidden="true" />
                        插入 {TEXT_PLACEHOLDER}
                      </button>
                    )}
                  </span>
                </span>
                <textarea
                  id="action-prompt"
                  className="control dialog-prompt"
                  aria-label="提示词"
                  value={prompt}
                  maxLength={10_000}
                  spellCheck={false}
                  onChange={(event) => {
                    setPrompt(event.target.value)
                    setError('')
                  }}
                />
                <span className="field__hint">
                  {kind === 'extract'
                    ? '截图工具栏会对每张截图运行此动作：截图作为图片随提示词一起发送给模型，仅出现在截图工具栏。'
                    : `默认提示词可以直接修改；恢复默认后需保存设置才会生效；${TEXT_PLACEHOLDER} 会替换为选中文本。`}
                </span>
              </label>
            </>
          )}

          {error && <div className="notice notice--error" role="alert">{error}</div>}
          <footer className="dialog-actions">
            <button className="button" type="button" onClick={onCancel}>取消</button>
            <button className="button button--primary" type="submit">
              {action ? '保存修改' : '添加动作'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  )
}
