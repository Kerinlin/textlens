export type AsyncEffectScope = 'result' | 'toolbar' | 'settings'

export interface DetachedEffectOptions {
  scope: AsyncEffectScope
  operation: string
  onError?: (error: unknown) => void
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : ''
}

export function isExpectedWindowGoneError(error: unknown): boolean {
  return /(?:结果(?:显示)?会话已结束|结果窗口.*已关闭|result session no longer exists|window.*(?:closed|destroyed|not found))/iu
    .test(errorText(error))
}

function errorClass(error: unknown): string {
  if (error instanceof DOMException) return 'DOMException'
  if (error instanceof Error) return error.name || 'Error'
  if (error === null) return 'null'
  return typeof error
}

export function runDetached(
  promise: Promise<unknown> | undefined,
  options: DetachedEffectOptions
): void {
  if (!promise) return
  void promise.catch((error: unknown) => {
    if (isExpectedWindowGoneError(error)) return
    if (options.onError) {
      options.onError(error)
      return
    }
    console.warn('[Flick][renderer]', {
      scope: options.scope,
      operation: options.operation,
      errorClass: errorClass(error)
    })
  })
}
