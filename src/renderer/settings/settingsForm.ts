import {
  MAX_ENABLED_ACTIONS,
  TEXT_PLACEHOLDER,
  isAiActionDefinition,
  isSearchActionDefinition,
  isValidTauriGlobalShortcut,
  publicSettingsSchema,
  settingsUpdateSchema,
  validateOpenAiBaseUrl,
  type ActionDefinition,
  type PublicProviderSettings,
  type PublicSettings,
  type SettingsUpdate
} from '../../shared'
import { isLucideIconName } from '../components/lucideIconRegistry'

export function sortAndNumberActions(actions: readonly ActionDefinition[]): ActionDefinition[] {
  return [...actions]
    .sort((left, right) => left.order - right.order)
    .map((action, index) => ({ ...action, order: index }))
}

export function reorderActions(
  actions: readonly ActionDefinition[],
  activeId: string,
  overId: string
): ActionDefinition[] {
  const ordered = sortAndNumberActions(actions)
  const activeIndex = ordered.findIndex((action) => action.id === activeId)
  const overIndex = ordered.findIndex((action) => action.id === overId)
  if (activeIndex < 0 || overIndex < 0 || activeIndex === overIndex) return ordered

  const moving = ordered[activeIndex]!
  ordered.splice(activeIndex, 1)
  ordered.splice(overIndex, 0, moving)
  return ordered.map((action, order) => ({ ...action, order }))
}

export function removeProviderFromSettings(
  settings: PublicSettings,
  providerId: PublicProviderSettings['id']
): PublicSettings {
  return {
    ...settings,
    providers: settings.providers.filter((provider) => provider.id !== providerId),
    actions: settings.actions.map((action) =>
      isAiActionDefinition(action) && action.providerId === providerId
        ? { ...action, providerId: '', modelId: '' }
        : action
    )
  }
}

export function removeProviderModelFromSettings(
  settings: PublicSettings,
  providerId: PublicProviderSettings['id'],
  modelId: string
): PublicSettings {
  return {
    ...settings,
    providers: settings.providers.map((provider) =>
      provider.id === providerId
        ? {
            ...provider,
            models: provider.models.filter((model) => model.id !== modelId)
          }
        : provider
    ),
    actions: settings.actions.map((action) =>
      isAiActionDefinition(action) &&
      action.providerId === providerId &&
      action.modelId === modelId
        ? { ...action, modelId: '' }
        : action
    )
  }
}

export function buildSettingsUpdate(settings: PublicSettings):
  | { valid: true; value: SettingsUpdate }
  | { valid: false; message: string } {
  if (settings.translate.primaryLanguage === settings.translate.alternateLanguage) {
    return { valid: false, message: '主要语言和另一语言不能相同' }
  }

  const captureShortcut = settings.captureShortcut.trim()
  const screenshotShortcut = settings.screenshotShortcut.trim()
  if (!isValidTauriGlobalShortcut(captureShortcut) || !isValidTauriGlobalShortcut(screenshotShortcut)) {
    return {
      valid: false,
      message: '捕获快捷键格式无效，请使用例如 CommandOrControl+Shift+S 的格式'
    }
  }
  if (settings.trigger.mode === 'shortcut' && captureShortcut === '') {
    return {
      valid: false,
      message: '快捷键触发模式需要设置捕获快捷键'
    }
  }

  for (const provider of settings.providers) {
    const validation = validateOpenAiBaseUrl(provider.baseUrl.trim())
    if (!validation.valid) return { valid: false, message: `“${provider.name}”：${validation.reason}` }
  }

  const actions = sortAndNumberActions(settings.actions)
  // Image-input actions only appear on the screenshot toolbar, so they never
  // consume the selection-toolbar slot budget.
  const enabledCount = actions.filter((action) => action.enabled && action.kind !== 'extract').length
  if (enabledCount < 1) return { valid: false, message: '至少需要启用一个工具栏动作' }
  if (enabledCount > MAX_ENABLED_ACTIONS) {
    return { valid: false, message: `最多只能启用 ${MAX_ENABLED_ACTIONS} 个动作` }
  }

  const providersById = new Map(settings.providers.map((provider) => [provider.id, provider]))
  for (const action of actions) {
    if (!isLucideIconName(action.icon)) {
      return { valid: false, message: `“${action.name}”使用了无效的 Lucide 图标` }
    }
    if (isSearchActionDefinition(action) && !action.searchEngineId) {
      return { valid: false, message: `“${action.name}”需要选择搜索引擎` }
    }
    if (!isAiActionDefinition(action)) continue
    // Image-input actions (extract) carry the capture as a multimodal part
    // and have no text placeholder requirement.
    if (action.kind !== 'extract' && !action.prompt.includes(TEXT_PLACEHOLDER)) {
      return { valid: false, message: `“${action.name}”的提示词必须包含 ${TEXT_PLACEHOLDER}` }
    }
    if (action.providerId) {
      const provider = providersById.get(action.providerId)
      if (!provider) return { valid: false, message: `“${action.name}”引用了不存在的服务商` }
      if (action.modelId && !provider.models.some((model) => model.id === action.modelId)) {
        return { valid: false, message: `“${action.name}”引用了不存在的模型` }
      }
    }
  }

  const candidate: SettingsUpdate = {
    enabled: settings.enabled,
    captureShortcut,
    screenshotShortcut,
    locale: settings.locale,
    translate: settings.translate,
    toolbar: settings.toolbar,
    result: settings.result,
    trigger: settings.trigger,
    application: settings.application,
    filter: settings.filter,
    selectionCapture: {
      defaultStrategy: settings.selectionCapture.defaultStrategy,
      applications: settings.selectionCapture.applications.map((rule) => ({
        application: rule.application.trim(),
        strategy: rule.strategy
      }))
    },
    providers: settings.providers.map(({ keyConfigured: _keyConfigured, ...provider }) => ({
      ...provider,
      baseUrl: provider.baseUrl.trim(),
      name: provider.name.trim(),
      models: provider.models.map((model) => ({
        id: model.id.trim(),
        name: model.name.trim(),
        thinkingLevels: model.thinkingLevels ?? [],
        thinkingCapability: model.thinkingCapability
      }))
    })),
    actions
  }

  const fullSettings = publicSettingsSchema.safeParse({
    ...settings,
    ...candidate,
    version: settings.version,
    providers: settings.providers.map((provider) => ({
      ...provider,
      baseUrl: provider.baseUrl.trim(),
      name: provider.name.trim(),
      models: provider.models.map((model) => ({
        id: model.id.trim(),
        name: model.name.trim(),
        thinkingLevels: model.thinkingLevels ?? [],
        thinkingCapability: model.thinkingCapability
      }))
    }))
  })
  if (!fullSettings.success) {
    return { valid: false, message: fullSettings.error.issues[0]?.message ?? '设置内容无效' }
  }
  const parsed = settingsUpdateSchema.safeParse(candidate)
  if (!parsed.success) {
    return { valid: false, message: parsed.error.issues[0]?.message ?? '设置内容无效' }
  }
  return { valid: true, value: parsed.data }
}
