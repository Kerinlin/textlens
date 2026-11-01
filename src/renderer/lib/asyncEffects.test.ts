import { runDetached } from './asyncEffects'

describe('runDetached', () => {
  it.each([
    '结果会话已结束',
    '结果显示会话已结束',
    'result session no longer exists',
    'window was already closed'
  ])('silences an expected gone error: %s', async (message) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    runDetached(Promise.reject(new Error(message)), {
      scope: 'result',
      operation: 'pointer-inside'
    })

    await Promise.resolve()

    expect(warn).not.toHaveBeenCalled()
  })

  it('logs only sanitized metadata for an unexpected rejection', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    runDetached(Promise.reject(new Error('selected secret text')), {
      scope: 'toolbar',
      operation: 'hide'
    })

    await Promise.resolve()

    expect(warn).toHaveBeenCalledWith('[Flick][renderer]', {
      scope: 'toolbar',
      operation: 'hide',
      errorClass: 'Error'
    })
    expect(JSON.stringify(warn.mock.calls)).not.toContain('selected secret text')
  })

  it('accepts an omitted promise', () => {
    expect(() => runDetached(undefined, {
      scope: 'settings',
      operation: 'optional-guidance'
    })).not.toThrow()
  })

  it('passes unexpected errors to onError without leaving a rejection unhandled', async () => {
    const onError = vi.fn()
    const unhandled = vi.fn()
    window.addEventListener('unhandledrejection', unhandled)
    try {
      runDetached(Promise.reject(new TypeError('private prompt')), {
        scope: 'result',
        operation: 'close',
        onError
      })

      await Promise.resolve()
      await Promise.resolve()

      expect(onError).toHaveBeenCalledWith(expect.any(TypeError))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('unhandledrejection', unhandled)
    }
  })
})
