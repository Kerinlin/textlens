import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'

import {
  orderedScreenshotToolbarIds,
  SCREENSHOT_TOOLBAR_ITEM_ICONS,
  SCREENSHOT_TOOLBAR_ITEM_NAMES,
  type PublicSettings
} from '../../shared'
import { ActionIcon } from '../components/ActionIcon'

type Tool = 'pen' | 'rect' | 'arrow' | 'mosaic' | 'text'
type ToolbarItemId = Tool | 'pin' | 'done'
type Point = { x: number; y: number }
type Rect = { x: number; y: number; width: number; height: number }
type Shot = { pngBase64: string; width: number; height: number }
type ExtractAction = { id: string; name: string; icon: string }
type TextEdit = { x: number; y: number; value: string }
type ToolbarItem = { id: ToolbarItemId; enabled: boolean; order: number }

const DEFAULT_TOOLBAR_ITEMS: ToolbarItem[] = (
  ['pen', 'rect', 'arrow', 'mosaic', 'text', 'pin', 'done'] as const
).map((id, order) => ({ id, enabled: true, order }))

const ANNOTATION_COLOR = '#e23d3d'
const TEXT_SIZE = 16
const MOSAIC_BLOCK = 16
const MIN_REGION = 4
const HANDLE_SIZE = 18

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

function SelectionShade({ hole }: { hole: Rect | null }) {
  if (!hole || hole.width < 1 || hole.height < 1) {
    return <div className="shot-shade" style={{ inset: 0 }} />
  }
  return (
    <>
      <div className="shot-shade" style={{ left: 0, top: 0, right: 0, height: hole.y }} />
      <div className="shot-shade" style={{ left: 0, top: hole.y, width: hole.x, height: hole.height }} />
      <div className="shot-shade" style={{ left: hole.x + hole.width, top: hole.y, right: 0, height: hole.height }} />
      <div className="shot-shade" style={{ left: 0, top: hole.y + hole.height, right: 0, bottom: 0 }} />
    </>
  )
}

function errorMessage(error: unknown): string {
  return typeof error === 'string' ? error : error instanceof Error ? error.message : '操作失败'
}

function clientRect(value: Rect): Rect {
  return {
    x: Math.min(value.x, value.x + value.width),
    y: Math.min(value.y, value.y + value.height),
    width: Math.abs(value.width),
    height: Math.abs(value.height)
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

// Keep a dragged edge or corner from crossing its opposite side, and keep the
// whole region inside the overlay. Handles report their new edge in window
// coordinates; the opposite edge stays put.
function resizeRegion(region: Rect, handle: Handle, point: Point, bounds: Rect): Rect {
  let left = region.x
  let top = region.y
  let right = region.x + region.width
  let bottom = region.y + region.height
  const maxX = bounds.x + bounds.width
  const maxY = bounds.y + bounds.height
  if (handle.includes('w')) left = clamp(point.x, bounds.x, right - MIN_REGION)
  if (handle.includes('e')) right = clamp(point.x, left + MIN_REGION, maxX)
  if (handle.includes('n')) top = clamp(point.y, bounds.y, bottom - MIN_REGION)
  if (handle.includes('s')) bottom = clamp(point.y, top + MIN_REGION, maxY)
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function handlePosition(region: Rect, handle: Handle): Point {
  const midX = region.x + region.width / 2
  const midY = region.y + region.height / 2
  const right = region.x + region.width
  const bottom = region.y + region.height
  const x = handle.includes('w') ? region.x : handle.includes('e') ? right : midX
  const y = handle.includes('n') ? region.y : handle.includes('s') ? bottom : midY
  return { x, y }
}

function handleCursor(handle: Handle): string {
  if (handle === 'n' || handle === 's') return 'ns-resize'
  if (handle === 'e' || handle === 'w') return 'ew-resize'
  if (handle === 'nw' || handle === 'se') return 'nwse-resize'
  return 'nesw-resize'
}

function SelectionChrome({
  region,
  size,
  interactive,
  onHandlePointerDown
}: {
  region: Rect
  size: { width: number; height: number }
  interactive: boolean
  onHandlePointerDown: (handle: Handle, event: ReactPointerEvent<HTMLButtonElement>) => void
}) {
  return (
    <>
      <div className="shot-selection" style={boxStyle(region)} />
      <div
        className="shot-size"
        style={{
          left: Math.max(4, region.x),
          top: region.y >= 28 ? region.y - 26 : region.y + 8
        }}
      >
        {`${Math.round(size.width)} × ${Math.round(size.height)}`}
      </div>
      {interactive &&
        HANDLES.map((handle) => {
          const point = handlePosition(region, handle)
          return (
            <button
              aria-label={handle}
              className={`shot-handle shot-handle-${handle}`}
              key={handle}
              style={{
                left: point.x - HANDLE_SIZE / 2,
                top: point.y - HANDLE_SIZE / 2,
                cursor: handleCursor(handle)
              }}
              type="button"
              onPointerDown={(event) => onHandlePointerDown(handle, event)}
            />
          )
        })}
    </>
  )
}

function boxStyle(value: Rect): CSSProperties {
  return { left: value.x, top: value.y, width: value.width, height: value.height }
}

export function ScreenshotApp() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const previewRef = useRef<HTMLCanvasElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const [toolbarWidth, setToolbarWidth] = useState(0)
  const [toolbarHeight, setToolbarHeight] = useState(0)
  const [draft, setDraft] = useState<Rect | null>(null)
  const [selection, setSelection] = useState<Rect | null>(null)
  const [shot, setShot] = useState<Shot | null>(null)
  const [tool, setTool] = useState<Tool>('pen')
  const [extractActions, setExtractActions] = useState<ExtractAction[]>([])
  const [toolbarItems, setToolbarItems] = useState<ToolbarItem[]>(DEFAULT_TOOLBAR_ITEMS)
  const [toolbarOrder, setToolbarOrder] = useState<string[]>(DEFAULT_TOOLBAR_ITEMS.map((item) => item.id))
  const [toolbarDisplayMode, setToolbarDisplayMode] = useState<PublicSettings['toolbar']['displayMode']>('icon-label')
  const [status, setStatus] = useState('')
  const [textEdit, setTextEdit] = useState<TextEdit | null>(null)
  const [resizing, setResizing] = useState(false)
  const origin = useRef<Point | null>(null)
  const draftRef = useRef<Rect | null>(null)
  const drawing = useRef(false)
  const annotateOrigin = useRef<Point | null>(null)
  const textEditRef = useRef<TextEdit | null>(null)
  const resizeHandle = useRef<Handle | null>(null)
  const resizeMoved = useRef(false)
  const selectionRef = useRef<Rect | null>(null)
  const shotRef = useRef<Shot | null>(null)
  const recapturing = useRef(false)
  const captureSeq = useRef(0)

  function updateTextEdit(value: TextEdit | null) {
    textEditRef.current = value
    setTextEdit(value)
  }

  function rememberSelection(value: Rect | null) {
    selectionRef.current = value
    setSelection(value)
  }

  function rememberShot(value: Shot | null) {
    shotRef.current = value
    setShot(value)
  }

  useEffect(() => {
    const toolbar = toolbarRef.current
    if (!toolbar) return
    const update = () => {
      setToolbarWidth(toolbar.offsetWidth)
      setToolbarHeight(toolbar.offsetHeight)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(toolbar)
    return () => observer.disconnect()
  }, [shot, resizing, extractActions.length, toolbarItems])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!shot || !canvas) return
    const context = canvas.getContext('2d')
    if (!context) return
    const image = new Image()
    image.onload = () => context.drawImage(image, 0, 0, canvas.width, canvas.height)
    image.src = `data:image/png;base64,${shot.pngBase64}`
  }, [shot])

  useEffect(() => {
    // Image-input actions are configured like any other action (provider,
    // model, prompt) and run through the standard result window. The overlay
    // is a long-lived reused window, so the list is re-read at the start of
    // every capture session and on settings broadcasts — never only on load.
    type ActionSettings = {
      actions: Array<{ id: string; name: string; icon?: string; kind: string; enabled: boolean; order: number }>
      toolbar?: {
        displayMode?: PublicSettings['toolbar']['displayMode']
        screenshotItems?: ToolbarItem[]
        screenshotOrder?: string[]
      }
    }
    const isAnnotationTool = (id: ToolbarItemId): id is Tool =>
      id === 'pen' || id === 'rect' || id === 'arrow' || id === 'mosaic' || id === 'text'

    const applyActions = (settings: ActionSettings) => {
      setToolbarDisplayMode(settings.toolbar?.displayMode ?? 'icon-label')
      setExtractActions(
        settings.actions
          .filter((action) => action.kind === 'extract' && action.enabled)
          .sort((left, right) => left.order - right.order)
          .map((action) => ({ id: action.id, name: action.name, icon: action.icon || 'scan-text' }))
      )
      const configured = settings.toolbar?.screenshotItems
      const nextItems = configured && configured.length > 0
        ? [...configured].sort((left, right) => left.order - right.order)
        : DEFAULT_TOOLBAR_ITEMS
      setToolbarOrder(orderedScreenshotToolbarIds(
        nextItems,
        settings.actions,
        settings.toolbar?.screenshotOrder ?? []
      ))
      setToolbarItems(nextItems)
      setTool((current) => {
        if (nextItems.some((item) => item.id === current && item.enabled)) return current
        const fallback = nextItems.find((item): item is ToolbarItem & { id: Tool } => item.enabled && isAnnotationTool(item.id))
        return fallback?.id ?? current
      })
    }
    const refreshActions = () => {
      void invoke<ActionSettings>('get_settings')
        .then(applyActions)
        .catch(() => undefined)
    }
    refreshActions()
    const stopSettings = listen<ActionSettings>('textlens:settings-changed', (event) => {
      applyActions(event.payload)
    })
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') void invoke('cancel_screenshot')
    }
    window.addEventListener('keydown', onKey)
    // A reused overlay window keeps its previous shot and annotations; the
    // native coordinator announces every fresh session so we start clean and
    // re-read the action list (broadcasts may have been missed while hidden).
    const stopReset = listen('textlens:screenshot-reset', () => {
      setDraft(null)
      rememberSelection(null)
      rememberShot(null)
      setStatus('')
      updateTextEdit(null)
      draftRef.current = null
      origin.current = null
      annotateOrigin.current = null
      drawing.current = false
      resizeHandle.current = null
      resizeMoved.current = false
      setResizing(false)
      recapturing.current = false
      captureSeq.current += 1
      refreshActions()
    })
    return () => {
      window.removeEventListener('keydown', onKey)
      void stopReset.then((unlisten) => unlisten())
      void stopSettings.then((unlisten) => unlisten())
    }
  }, [])

  function rememberDraft(value: Rect | null) {
    draftRef.current = value
    setDraft(value)
  }

  function stageToCanvas(event: ReactPointerEvent<HTMLDivElement>): Point {
    const canvas = canvasRef.current
    const area = selectionRef.current ?? { x: 0, y: 0, width: 1, height: 1 }
    const scale = canvas ? canvas.width / area.width : 1
    return { x: (event.clientX - area.x) * scale, y: (event.clientY - area.y) * scale }
  }

  function strokeScale(): number {
    const canvas = canvasRef.current
    const area = selectionRef.current ?? { width: 1, height: 1 }
    return canvas ? canvas.width / area.width : 1
  }

  function overlayBounds(): Rect {
    return { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }
  }

  async function confirmSelection(region: Rect, options?: { quiet?: boolean }) {
    const normalized = clientRect(region)
    if (normalized.width < MIN_REGION || normalized.height < MIN_REGION) return
    const seq = captureSeq.current + 1
    captureSeq.current = seq
    recapturing.current = true
    if (!options?.quiet) setStatus('正在截取…')
    try {
      // Send the client-area logical rect; the native side maps it to global
      // physical pixels using the overlay's own origin and scale factor.
      const captured = await invoke<Shot>('capture_screenshot_region', {
        region: {
          x: normalized.x,
          y: normalized.y,
          width: normalized.width,
          height: normalized.height
        }
      })
      if (captureSeq.current !== seq) return
      rememberShot(captured)
      rememberSelection(normalized)
      setStatus('')
    } catch (error) {
      if (captureSeq.current !== seq) return
      setStatus(errorMessage(error))
    } finally {
      if (captureSeq.current === seq) recapturing.current = false
    }
  }

  function onHandlePointerDown(handle: Handle, event: ReactPointerEvent<HTMLButtonElement>) {
    if (!selectionRef.current || recapturing.current) return
    // Keep the handle mounted for the whole gesture and let the stage own
    // pointer capture. Unmounting the handle on pointerdown released capture
    // before the first move, so the region never changed.
    event.preventDefault()
    event.stopPropagation()
    commitTextEdit()
    resizeHandle.current = handle
    resizeMoved.current = false
    setResizing(true)
    const stage = event.currentTarget.closest('.shot-stage')
    if (stage instanceof HTMLElement) stage.setPointerCapture(event.pointerId)
  }

  function finishResize() {
    if (!resizeHandle.current) return
    const moved = resizeMoved.current
    resizeHandle.current = null
    resizeMoved.current = false
    setResizing(false)
    const next = selectionRef.current
    if (!next || !moved) return
    // Recapture quietly. The previous bitmap stays visible until the new one
    // arrives, so the overlay does not flash back to the dimmed desktop.
    // Annotations drawn against the old region are discarded with that bitmap.
    void confirmSelection(next, { quiet: true })
  }

  function commitTextEdit() {
    // Blur and pointer-down can both try to commit the same edit; consume it
    // from the ref so the text is only stamped onto the canvas once.
    const edit = textEditRef.current
    textEditRef.current = null
    const canvas = canvasRef.current
    setTextEdit(null)
    const area = selectionRef.current
    if (!edit || !edit.value.trim() || !canvas || !area) return
    const context = canvas.getContext('2d')
    if (!context) return
    const scale = canvas.width / area.width
    const x = (edit.x - area.x) * scale
    let y = (edit.y - area.y) * scale
    context.globalCompositeOperation = 'source-over'
    context.fillStyle = ANNOTATION_COLOR
    context.textBaseline = 'top'
    context.font = `${Math.round(TEXT_SIZE * scale)}px sans-serif`
    for (const line of edit.value.split('\n')) {
      context.fillText(line, x, y)
      y += Math.round(TEXT_SIZE * scale * 1.3)
    }
  }

  function strokeArrow(context: CanvasRenderingContext2D, from: Point, to: Point, width: number) {
    context.lineWidth = width
    context.beginPath()
    context.moveTo(from.x, from.y)
    context.lineTo(to.x, to.y)
    context.stroke()
    const angle = Math.atan2(to.y - from.y, to.x - from.x)
    const head = Math.max(10, width * 4)
    context.beginPath()
    context.moveTo(to.x, to.y)
    context.lineTo(to.x - head * Math.cos(angle - 0.4), to.y - head * Math.sin(angle - 0.4))
    context.moveTo(to.x, to.y)
    context.lineTo(to.x - head * Math.cos(angle + 0.4), to.y - head * Math.sin(angle + 0.4))
    context.stroke()
  }

  function pixelateRegion(from: Point, to: Point) {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return
    const left = Math.max(0, Math.round(Math.min(from.x, to.x)))
    const top = Math.max(0, Math.round(Math.min(from.y, to.y)))
    const right = Math.min(canvas.width, Math.round(Math.max(from.x, to.x)))
    const bottom = Math.min(canvas.height, Math.round(Math.max(from.y, to.y)))
    if (right - left < 2 || bottom - top < 2) return
    const block = Math.max(4, Math.round(MOSAIC_BLOCK * strokeScale()))
    const region = context.getImageData(left, top, right - left, bottom - top)
    for (let y = 0; y < region.height; y += block) {
      for (let x = 0; x < region.width; x += block) {
        let red = 0
        let green = 0
        let blue = 0
        let count = 0
        for (let py = y; py < Math.min(y + block, region.height); py += 1) {
          for (let px = x; px < Math.min(x + block, region.width); px += 1) {
            const offset = (py * region.width + px) * 4
            red += region.data[offset]!
            green += region.data[offset + 1]!
            blue += region.data[offset + 2]!
            count += 1
          }
        }
        if (!count) continue
        context.fillStyle = `rgb(${Math.round(red / count)},${Math.round(green / count)},${Math.round(blue / count)})`
        context.fillRect(left + x, top + y, Math.min(block, region.width - x), Math.min(block, region.height - y))
      }
    }
  }

  function onStagePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (resizeHandle.current || recapturing.current) return
    const selection = selectionRef.current
    const shot = shotRef.current
    if (shot && selection) {
      const inside =
        event.clientX >= selection.x &&
        event.clientX <= selection.x + selection.width &&
        event.clientY >= selection.y &&
        event.clientY <= selection.y + selection.height
      if (!inside) return
      if (tool === 'text') {
        // Suppress the click's default focus change so the freshly mounted
        // textarea keeps focus instead of blurring (and committing) at once.
        event.preventDefault()
        commitTextEdit()
        updateTextEdit({ x: event.clientX, y: event.clientY, value: '' })
        return
      }
      const point = stageToCanvas(event)
      const canvas = canvasRef.current
      const context = canvas?.getContext('2d')
      drawing.current = true
      annotateOrigin.current = point
      event.currentTarget.setPointerCapture(event.pointerId)
      if (tool === 'pen' && canvas && context) {
        context.globalCompositeOperation = 'source-over'
        context.strokeStyle = ANNOTATION_COLOR
        context.lineWidth = 3 * strokeScale()
        context.lineCap = 'round'
        context.beginPath()
        context.moveTo(point.x, point.y)
      }
      return
    }
    origin.current = { x: event.clientX, y: event.clientY }
    rememberDraft({ x: event.clientX, y: event.clientY, width: 0, height: 0 })
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function onStagePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const handle = resizeHandle.current
    const current = selectionRef.current
    if (handle && current) {
      resizeMoved.current = true
      rememberSelection(resizeRegion(current, handle, { x: event.clientX, y: event.clientY }, overlayBounds()))
      return
    }
    const selection = selectionRef.current
    const shot = shotRef.current
    if (shot && selection) {
      if (!drawing.current || !annotateOrigin.current) return
      const from = annotateOrigin.current
      const to = stageToCanvas(event)
      if (tool === 'pen') {
        const context = canvasRef.current?.getContext('2d')
        if (!context) return
        context.lineTo(to.x, to.y)
        context.stroke()
        return
      }
      const preview = previewRef.current
      const context = preview?.getContext('2d')
      if (!preview || !context) return
      context.clearRect(0, 0, preview.width, preview.height)
      if (tool === 'rect') {
        context.strokeStyle = ANNOTATION_COLOR
        context.lineWidth = 3 * strokeScale()
        context.strokeRect(from.x, from.y, to.x - from.x, to.y - from.y)
      } else if (tool === 'arrow') {
        context.strokeStyle = ANNOTATION_COLOR
        context.lineCap = 'round'
        strokeArrow(context, from, to, 3 * strokeScale())
      } else if (tool === 'mosaic') {
        context.fillStyle = 'rgba(12, 12, 14, 0.35)'
        context.fillRect(from.x, from.y, to.x - from.x, to.y - from.y)
      }
      return
    }
    if (!origin.current) return
    rememberDraft({
      x: origin.current.x,
      y: origin.current.y,
      width: event.clientX - origin.current.x,
      height: event.clientY - origin.current.y
    })
  }

  function onStagePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (resizeHandle.current) {
      finishResize()
      return
    }
    const shot = shotRef.current
    if (shot) {
      if (!drawing.current) return
      drawing.current = false
      const from = annotateOrigin.current
      annotateOrigin.current = null
      const preview = previewRef.current
      preview?.getContext('2d')?.clearRect(0, 0, preview.width, preview.height)
      if (!from) return
      const to = stageToCanvas(event)
      const context = canvasRef.current?.getContext('2d')
      if (!context) return
      if (tool === 'rect') {
        context.globalCompositeOperation = 'source-over'
        context.strokeStyle = ANNOTATION_COLOR
        context.lineWidth = 3 * strokeScale()
        context.strokeRect(from.x, from.y, to.x - from.x, to.y - from.y)
      } else if (tool === 'arrow') {
        context.globalCompositeOperation = 'source-over'
        context.strokeStyle = ANNOTATION_COLOR
        context.lineCap = 'round'
        strokeArrow(context, from, to, 3 * strokeScale())
      } else if (tool === 'mosaic') {
        pixelateRegion(from, to)
      }
      return
    }
    if (!origin.current) return
    const pending = draftRef.current
    origin.current = null
    if (!shot && pending) void confirmSelection(pending)
  }

  async function exportAnnotated(): Promise<string | null> {
    const canvas = canvasRef.current
    const current = shotRef.current
    if (!canvas || !current) return current?.pngBase64 ?? null
    const exported = canvas.toDataURL('image/png').split(',')[1]
    return exported || current.pngBase64
  }

  async function copy() {
    try {
      const png = await exportAnnotated()
      if (!png) return
      await invoke('copy_screenshot', { pngBase64: png })
      // Copy is a terminal action: dismiss the overlay like the done button.
      await getCurrentWindow().hide()
    } catch (error) {
      setStatus(errorMessage(error))
    }
  }

  async function pin() {
    try {
      const png = await exportAnnotated()
      const current = shotRef.current
      if (!png || !current) return
      await invoke('pin_screenshot', { pngBase64: png, width: current.width, height: current.height })
    } catch (error) {
      setStatus(errorMessage(error))
    }
  }

  async function runExtract(actionId: string) {
    try {
      const png = await exportAnnotated()
      if (!png) {
        setStatus('还没有可用的截图')
        return
      }
      setStatus('正在提取文字…')
      const result = await invoke<{ accepted: boolean; message?: string }>('run_screenshot_action', {
        actionId,
        pngBase64: png
      })
      if (!result.accepted) {
        setStatus(result.message ?? '提取文字失败')
      }
      // On success the overlay is dismissed by the command once the result
      // window has revealed; the streaming answer lands there.
    } catch (error) {
      setStatus(errorMessage(error))
    }
  }

  const active = selection ?? (draft ? clientRect(draft) : null)
  const toolbarTop = active
    ? Math.max(8, Math.min(
      active.y + active.height + 10,
      window.innerHeight - Math.max(toolbarHeight, 36) - 8
    ))
    : 0
  const toolbarLeft = active
    ? Math.max(8, Math.min(active.x, window.innerWidth - Math.max(toolbarWidth, 8) - 8))
    : 0
  return (
    <div
      className="shot-stage"
      onPointerDown={onStagePointerDown}
      onPointerMove={onStagePointerMove}
      onPointerUp={onStagePointerUp}
    >
      {(!shot || resizing) && <SelectionShade hole={active} />}
      {active && (
        <SelectionChrome
          interactive={Boolean(shot) || resizing}
          region={active}
          size={active}
          onHandlePointerDown={onHandlePointerDown}
        />
      )}
      {shot && selection && !resizing && (
        <>
          <canvas
            ref={canvasRef}
            className="shot-canvas"
            width={shot.width}
            height={shot.height}
            style={boxStyle(selection)}
          />
          <canvas
            ref={previewRef}
            className="shot-canvas shot-preview"
            width={shot.width}
            height={shot.height}
            style={boxStyle(selection)}
          />
          {textEdit && (
            <textarea
              autoFocus
              className="shot-text-input"
              style={{ left: textEdit.x, top: textEdit.y, color: ANNOTATION_COLOR }}
              value={textEdit.value}
              onBlur={() => commitTextEdit()}
              onChange={(event) => updateTextEdit({ ...textEdit, value: event.target.value })}
              onKeyDown={(event) => {
                event.stopPropagation()
                if (event.key === 'Escape') updateTextEdit(null)
                if (event.key === 'Enter' && !event.shiftKey) commitTextEdit()
              }}
              onPointerDown={(event) => event.stopPropagation()}
            />
          )}
        </>
      )}
      {shot && !resizing && active && active.width >= MIN_REGION && active.height >= MIN_REGION && (
        <div
          ref={toolbarRef}
          className={`shot-toolbar ${toolbarDisplayMode === 'icon-only' ? 'shot-toolbar--icons' : ''}`}
          style={{ left: toolbarLeft, top: Math.max(8, toolbarTop) }}
          onPointerDown={(event) => event.stopPropagation()}
          onPointerMove={(event) => event.stopPropagation()}
          onPointerUp={(event) => event.stopPropagation()}
        >
          {toolbarOrder.map((id) => {
            const item = toolbarItems.find((candidate) => candidate.id === id)
            if (item) {
              if (!item.enabled) return null
              return (
                <button
                  aria-label={SCREENSHOT_TOOLBAR_ITEM_NAMES[item.id]}
                  className={tool === item.id && item.id !== 'pin' && item.id !== 'done' ? 'is-selected' : ''}
                  key={item.id}
                  title={item.id === 'done' ? '复制并完成' : SCREENSHOT_TOOLBAR_ITEM_NAMES[item.id]}
                  type="button"
                  onClick={() => {
                    if (item.id === 'pin') void pin()
                    else if (item.id === 'done') void copy()
                    else setTool(item.id)
                  }}
                >
                  <ActionIcon name={SCREENSHOT_TOOLBAR_ITEM_ICONS[item.id]} size={15} />
                  {toolbarDisplayMode !== 'icon-only' && <span>{SCREENSHOT_TOOLBAR_ITEM_NAMES[item.id]}</span>}
                </button>
              )
            }
            const action = extractActions.find((candidate) => candidate.id === id)
            if (!action) return null
            return (
              <button aria-label={action.name} key={action.id} title={action.name} type="button" onClick={() => void runExtract(action.id)}>
                <ActionIcon name={action.icon} size={15} />
                {toolbarDisplayMode !== 'icon-only' && <span>{action.name}</span>}
              </button>
            )
          })}
        </div>
      )}
      {status && <div className="shot-status" style={{ left: 16, bottom: 16 }}>{status}</div>}
    </div>
  )
}
