import { z } from 'zod'

export const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const
export type ThinkingLevel = (typeof THINKING_LEVELS)[number]
export type ThinkingMode = 'off' | ThinkingLevel

export const thinkingLevelSchema = z.enum(THINKING_LEVELS)
export const thinkingModeSchema = z.union([z.literal('off'), thinkingLevelSchema])

export const thinkingCapabilitySourceSchema = z.enum(['explicit', 'heuristic'])
export type ThinkingCapabilitySource = z.infer<typeof thinkingCapabilitySourceSchema>

export const thinkingDialectSchema = z.enum([
  'reasoningEffort',
  'enableThinking',
  'chatTemplateKwargs'
])
export type ThinkingDialect = z.infer<typeof thinkingDialectSchema>

export const thinkingCapabilitySchema = z
  .object({
    source: thinkingCapabilitySourceSchema,
    dialect: thinkingDialectSchema.nullable(),
    supportsOff: z.boolean()
  })
  .strict()
export type ThinkingCapability = z.infer<typeof thinkingCapabilitySchema>

export const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
  minimal: '最低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '最高'
}

const STANDARD_THREE: ThinkingLevel[] = ['low', 'medium', 'high']
const OPENAI_FULL: ThinkingLevel[] = ['minimal', 'low', 'medium', 'high', 'xhigh']

/** Infer capability from model id when /models metadata is silent. */
export function inferThinkingLevels(modelId: string): ThinkingLevel[] {
  const id = modelId.trim().toLowerCase()
  if (!id) return []

  // Prefer more specific patterns first.
  if (/(^|[/:_-])(o1|o3|o4)([/:_-]|$)/.test(id) || id.includes('o1-') || id.includes('o3-') || id.includes('o4-')) {
    return [...STANDARD_THREE]
  }
  if (id.includes('gpt-5') || id.includes('gpt5')) {
    return [...OPENAI_FULL]
  }
  if (id.includes('deepseek-r1') || id.includes('deepseek-reasoner')) {
    return [...STANDARD_THREE]
  }
  if (id.includes('qwen3') && (id.includes('think') || id.includes('reasoning') || !id.includes('instruct'))) {
    // qwen3 family often supports thinking; keep three gears without overclaiming xhigh
    return [...STANDARD_THREE]
  }
  if (id.includes('thinking') || id.includes('reasoner') || id.includes('reasoning')) {
    return [...STANDARD_THREE]
  }
  return []
}

export function clampThinkingMode(
  mode: ThinkingMode,
  levels: readonly ThinkingLevel[]
): ThinkingMode {
  if (mode === 'off') return 'off'
  return levels.includes(mode) ? mode : 'off'
}

export function thinkingModeLabel(mode: ThinkingMode): string {
  if (mode === 'off') return '关闭思考'
  return THINKING_LEVEL_LABELS[mode]
}

/**
 * Levels to offer in the action editor. Configured model levels win; an empty
 * list falls back to the model-id heuristic so existing models keep working.
 */
export function effectiveThinkingLevels(
  modelId: string,
  storedLevels?: readonly ThinkingLevel[] | null
): ThinkingLevel[] {
  if (storedLevels && storedLevels.length > 0) return [...storedLevels]
  return inferThinkingLevels(modelId)
}

/**
 * Whether the action editor should offer “关闭思考”.
 * Always available when the model has thinking levels; backend adapts via
 * `supportsOff` (inject off-control vs omit the field).
 */
export function modelSupportsThinkingOff(levels: readonly ThinkingLevel[]): boolean {
  return levels.length > 0
}
