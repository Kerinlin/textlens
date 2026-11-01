export const APP_NAME = 'Flick'
export const APP_ID = 'com.local.flick'

export const SETTINGS_VERSION = 13 as const
export const AI_TEXT_LIMIT = 20_000
export const AI_PROMPT_LIMIT = 50_000
export const AI_OUTPUT_LIMIT = 1_000_000
export const MAX_ENABLED_ACTIONS = 8
export const MAX_ACTIONS = 50
export const MAX_PROVIDERS = 20
export const MAX_PROVIDER_MODELS = 200
export const RESULT_FONT_SIZE_MIN = 12
export const RESULT_FONT_SIZE_MAX = 24
export const DEFAULT_RESULT_FONT_SIZE = 14

export const TEXT_PLACEHOLDER = '{{text}}'
export const OUTPUT_LANGUAGE_PLACEHOLDER = '{{language}}'
export const TARGET_LANGUAGE_PLACEHOLDER = '{{target_language}}'
export const DEFAULT_SEARCH_TEMPLATE = `https://www.google.com/search?q=${TEXT_PLACEHOLDER}`
export const BING_CHINA_SEARCH_TEMPLATE = `https://cn.bing.com/search?q=${TEXT_PLACEHOLDER}`
export const BAIDU_SEARCH_TEMPLATE = `https://www.baidu.com/s?wd=${TEXT_PLACEHOLDER}`
export const BUILTIN_SEARCH_ENGINE_IDS = ['google', 'bing-china', 'baidu'] as const
export type BuiltinSearchEngineId = (typeof BUILTIN_SEARCH_ENGINE_IDS)[number]
export const DEFAULT_SEARCH_ENGINE_ID = 'google' as const
/** @deprecated Use DEFAULT_SEARCH_ENGINE_ID. */
export const DEFAULT_ACTIVE_SEARCH_ENGINE_ID = DEFAULT_SEARCH_ENGINE_ID
export const DEFAULT_SEARCH_ENGINES = [
  {
    id: 'google',
    name: 'Google',
    template: DEFAULT_SEARCH_TEMPLATE,
    builtin: true
  },
  {
    id: 'bing-china',
    name: 'Bing',
    template: BING_CHINA_SEARCH_TEMPLATE,
    builtin: true
  },
  {
    id: 'baidu',
    name: '百度',
    template: BAIDU_SEARCH_TEMPLATE,
    builtin: true
  }
] as const
export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1'
export const DEFAULT_PROVIDER_ID = 'openai-compatible'
export const DEFAULT_PROVIDER_NAME = 'OpenAI Compatible'
/** @deprecated Models now live under providers. */
export const DEFAULT_MODEL = ''
export const DEFAULT_CAPTURE_SHORTCUT = ''
export const DEFAULT_SCREENSHOT_SHORTCUT = 'CommandOrControl+Shift+A'

export const DEFAULT_LOCALE = 'zh-CN' as const
export const DEFAULT_TRANSLATION_PAIR = {
  primaryLanguage: 'zh-CN',
  alternateLanguage: 'en-US'
} as const

export const SCREENSHOT_TOOLBAR_ITEM_IDS = [
  'pen',
  'rect',
  'arrow',
  'mosaic',
  'text',
  'pin',
  'done'
] as const

export const SCREENSHOT_TOOLBAR_ITEM_NAMES: Readonly<Record<(typeof SCREENSHOT_TOOLBAR_ITEM_IDS)[number], string>> = {
  pen: '画笔',
  rect: '矩形',
  arrow: '箭头',
  mosaic: '马赛克',
  text: '文字',
  pin: '贴图',
  done: '完成'
}

export const SCREENSHOT_TOOLBAR_ITEM_ICONS: Readonly<Record<(typeof SCREENSHOT_TOOLBAR_ITEM_IDS)[number], string>> = {
  pen: 'pen-line',
  rect: 'square',
  arrow: 'arrow-up-right',
  mosaic: 'grid-3x3',
  text: 'type',
  pin: 'pin',
  done: 'check'
}

export const DEFAULT_SCREENSHOT_TOOLBAR_ITEMS = SCREENSHOT_TOOLBAR_ITEM_IDS.map((id, order) => ({
  id,
  enabled: true,
  order
}))

export const DEFAULT_TOOLBAR_SETTINGS = {
  displayMode: 'icon-label',
  screenshotItems: DEFAULT_SCREENSHOT_TOOLBAR_ITEMS,
  screenshotOrder: []
} as const

export const DEFAULT_RESULT_SETTINGS = {
  followCursor: true,
  rememberSize: true,
  defaultPinned: false,
  dismissMode: 'blur',
  dismissDelayMs: 450,
  opacity: 1,
  fontSize: DEFAULT_RESULT_FONT_SIZE,
  lastSize: null
} as const

export const DEFAULT_TRIGGER_SETTINGS = {
  mode: 'selected'
} as const

export const DEFAULT_APPLICATION_SETTINGS = {
  closeBehavior: 'hide-to-tray'
} as const

export const DEFAULT_FILTER_SETTINGS = {
  mode: 'default',
  applications: []
} as const

export const DEFAULT_SELECTION_CAPTURE_SETTINGS = {
  defaultStrategy: 'selection-hook',
  applications: [
    { application: 'acrobat.exe', strategy: 'clipboard' },
    { application: 'acrord32.exe', strategy: 'clipboard' },
    { application: 'acrocef.exe', strategy: 'clipboard' },
    { application: 'rdrcef.exe', strategy: 'clipboard' },
    { application: 'docbox.exe', strategy: 'clipboard' },
    { application: 'docboxrenderer.exe', strategy: 'clipboard' },
    { application: 'emeditor.exe', strategy: 'clipboard' }
  ]
} as const

export const TOOLBAR_SCREEN_GAP = 8
export const TOOLBAR_SCREEN_MARGIN = 8

export function templateForSearchEngineId(id: string): string {
  if (id === 'bing-china') return BING_CHINA_SEARCH_TEMPLATE
  if (id === 'baidu') return BAIDU_SEARCH_TEMPLATE
  return DEFAULT_SEARCH_TEMPLATE
}

export function searchEngineDisplayName(id: string): string {
  if (id === 'bing-china') return 'Bing'
  if (id === 'baidu') return '百度'
  if (id === 'google') return 'Google'
  return id
}
