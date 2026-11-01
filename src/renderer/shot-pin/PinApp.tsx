import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useEffect, useState, type PointerEvent as ReactPointerEvent } from 'react'

type PinPayload = { pngBase64: string; width: number; height: number }

export function PinApp() {
  const [shot, setShot] = useState<PinPayload | null>(null)
  const [failed, setFailed] = useState('')

  useEffect(() => {
    void invoke<PinPayload | null>('get_shot_pin_payload')
      .then((payload) => {
        if (payload) setShot(payload)
        else setFailed('没有读取到贴图内容')
      })
      .catch((error) => {
        setFailed(typeof error === 'string' ? error : error instanceof Error ? error.message : '读取贴图失败')
      })
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') void getCurrentWindow().close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  function beginDrag(event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0) return
    event.preventDefault()
    void getCurrentWindow().startDragging()
  }

  // The native window is created at the image's exact aspect ratio, so the
  // bare <img> keeps a 1:1 mapping with the captured region. Dragging the
  // image moves the pin; Escape is the only way out.
  if (failed) {
    return <div className="pin-empty" onPointerDown={beginDrag}>{failed}，按 Esc 关闭</div>
  }
  if (!shot) return null
  return (
    <img
      alt="贴在屏幕上的截图"
      src={`data:image/png;base64,${shot.pngBase64}`}
      onContextMenu={(event) => {
        // Right-click closes without needing the window to be key first.
        event.preventDefault()
        void getCurrentWindow().close()
      }}
      onPointerDown={beginDrag}
    />
  )
}
