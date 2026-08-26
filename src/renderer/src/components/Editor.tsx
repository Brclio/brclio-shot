import {
  ArrowUpRight,
  Check,
  Circle,
  Copy,
  Crop,
  Droplets,
  Grid3X3,
  Hash,
  Highlighter,
  Minus,
  MousePointer2,
  PenTool,
  Pin,
  Redo2,
  Save,
  Square,
  Trash2,
  Type,
  Undo2,
  X,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import type {
  CSSProperties,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent
} from 'react'
import type {
  Annotation,
  AnnotationTool,
  BoundsAnnotation,
  CaptureAsset,
  LineAnnotation,
  NumberAnnotation,
  PathAnnotation,
  Point,
  TextAnnotation
} from '../../../shared/types'
import {
  drawEditorScene,
  exportEditorDataUrl,
  getActiveCrop,
  hitTestAnnotation,
  loadCanvasImage,
  translateAnnotation
} from '../lib/editorCanvas'

export interface EditorProps {
  asset: CaptureAsset
  onClose?: () => void
}

type EditorTool = Exclude<AnnotationTool, 'color-picker'>

interface ToolItem {
  tool: EditorTool
  label: string
  shortcut: string
  icon: LucideIcon
}

interface TextEntry {
  point: Point
  value: string
}

interface DrawGesture {
  kind: 'draw'
  pointerId: number
  base: Annotation[]
  start: Point
}

interface MoveGesture {
  kind: 'move'
  pointerId: number
  base: Annotation[]
  start: Point
  annotationId: string
}

type Gesture = DrawGesture | MoveGesture

const TOOL_ITEMS: ToolItem[] = [
  { tool: 'select', label: '选择', shortcut: 'V', icon: MousePointer2 },
  { tool: 'crop', label: '裁剪', shortcut: 'C', icon: Crop },
  { tool: 'rectangle', label: '矩形', shortcut: 'R', icon: Square },
  { tool: 'ellipse', label: '椭圆', shortcut: 'O', icon: Circle },
  { tool: 'arrow', label: '箭头', shortcut: 'A', icon: ArrowUpRight },
  { tool: 'line', label: '直线', shortcut: 'L', icon: Minus },
  { tool: 'pen', label: '画笔', shortcut: 'P', icon: PenTool },
  { tool: 'highlighter', label: '荧光笔', shortcut: 'H', icon: Highlighter },
  { tool: 'text', label: '文字', shortcut: 'T', icon: Type },
  { tool: 'number', label: '序号', shortcut: 'N', icon: Hash },
  { tool: 'mosaic', label: '马赛克', shortcut: 'M', icon: Grid3X3 },
  { tool: 'blur', label: '模糊', shortcut: 'B', icon: Droplets }
]

const TOOL_SHORTCUTS = new Map(
  TOOL_ITEMS.map((item) => [item.shortcut.toLowerCase(), item.tool] as const)
)

const rootStyle: CSSProperties = {
  width: '100%',
  height: '100%',
  minWidth: 0,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column'
}

const workspaceStyle: CSSProperties = {
  position: 'relative',
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  overflow: 'auto'
}

function makeId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `annotation-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function pointDistance(start: Point, end: Point): number {
  return Math.hypot(end.x - start.x, end.y - start.y)
}

function pointerPoint(event: ReactPointerEvent<HTMLCanvasElement>, canvas: HTMLCanvasElement): Point {
  const rect = canvas.getBoundingClientRect()
  return {
    x: ((event.clientX - rect.left) / Math.max(1, rect.width)) * canvas.width,
    y: ((event.clientY - rect.top) / Math.max(1, rect.height)) * canvas.height
  }
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'))
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请重试'
}

function modeLabel(mode: CaptureAsset['mode']): string {
  const labels: Record<CaptureAsset['mode'], string> = {
    region: '区域截图',
    window: '窗口截图',
    fullscreen: '全屏截图',
    scroll: '长截图',
    webpage: '网页截图',
    delay: '延时截图'
  }
  return labels[mode]
}

export default function Editor({ asset, onClose }: EditorProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const workspaceRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const gestureRef = useRef<Gesture | null>(null)
  const draftRef = useRef<Annotation | null>(null)
  const fitFollowingRef = useRef(true)

  const [image, setImage] = useState<HTMLImageElement | null>(null)
  const [imageError, setImageError] = useState<string | null>(null)
  const [tool, setTool] = useState<EditorTool>('select')
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [past, setPast] = useState<Annotation[][]>([])
  const [future, setFuture] = useState<Annotation[][]>([])
  const [draft, setDraft] = useState<Annotation | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [color, setColor] = useState('#f04f3d')
  const [strokeWidth, setStrokeWidth] = useState(4)
  const [fitZoom, setFitZoom] = useState(1)
  const [zoom, setZoom] = useState(1)
  const [textEntry, setTextEntry] = useState<TextEntry | null>(null)
  const [busyAction, setBusyAction] = useState<'copy' | 'save' | 'pin' | null>(null)
  const [actionStatus, setActionStatus] = useState<string>('')

  const imageWidth = Math.max(1, asset.width)
  const imageHeight = Math.max(1, asset.height)
  const selectedAnnotation = annotations.find((annotation) => annotation.id === selectedId) ?? null
  const activeCrop = useMemo(
    () => getActiveCrop(annotations, imageWidth, imageHeight),
    [annotations, imageHeight, imageWidth]
  )
  const outputWidth = activeCrop?.width ?? imageWidth
  const outputHeight = activeCrop?.height ?? imageHeight
  const modifierLabel = window.brclioShot.platform === 'darwin' ? '⌘' : 'Ctrl'

  const setDraftAnnotation = useCallback((next: Annotation | null): void => {
    draftRef.current = next
    setDraft(next)
  }, [])

  const recordPrevious = useCallback((previous: Annotation[]): void => {
    setPast((stack) => [...stack.slice(-99), previous])
    setFuture([])
  }, [])

  const commitAnnotations = useCallback(
    (next: Annotation[], previous = annotations): void => {
      recordPrevious(previous)
      setAnnotations(next)
    },
    [annotations, recordPrevious]
  )

  const cancelGesture = useCallback((): void => {
    const gesture = gestureRef.current
    if (gesture?.kind === 'move') setAnnotations(gesture.base)
    gestureRef.current = null
    setDraftAnnotation(null)
  }, [setDraftAnnotation])

  const undo = useCallback((): void => {
    if (gestureRef.current) cancelGesture()
    if (past.length === 0) return
    const previous = past[past.length - 1]
    setPast(past.slice(0, -1))
    setFuture([annotations, ...future])
    setAnnotations(previous)
    setSelectedId(null)
  }, [annotations, cancelGesture, future, past])

  const redo = useCallback((): void => {
    if (gestureRef.current) cancelGesture()
    if (future.length === 0) return
    const next = future[0]
    setPast([...past, annotations])
    setFuture(future.slice(1))
    setAnnotations(next)
    setSelectedId(null)
  }, [annotations, cancelGesture, future, past])

  const deleteSelected = useCallback((): void => {
    if (!selectedId) return
    const next = annotations.filter((annotation) => annotation.id !== selectedId)
    if (next.length === annotations.length) return
    commitAnnotations(next)
    setSelectedId(null)
  }, [annotations, commitAnnotations, selectedId])

  const clearAnnotations = useCallback((): void => {
    if (annotations.length === 0) return
    commitAnnotations([])
    setSelectedId(null)
  }, [annotations, commitAnnotations])

  const chooseTool = useCallback((nextTool: EditorTool): void => {
    cancelGesture()
    setTextEntry(null)
    setTool(nextTool)
    if (nextTool !== 'select') setSelectedId(null)
  }, [cancelGesture])

  const changeZoom = useCallback((delta: number): void => {
    fitFollowingRef.current = false
    setZoom((current) => Math.min(4, Math.max(0.05, current * (delta > 0 ? 1.15 : 1 / 1.15))))
  }, [])

  const resetZoom = useCallback((): void => {
    fitFollowingRef.current = true
    setZoom(fitZoom)
  }, [fitZoom])

  const exportedDataUrl = useCallback((): string => {
    if (!imageRef.current) throw new Error('截图仍在加载')
    return exportEditorDataUrl(imageRef.current, annotations, imageWidth, imageHeight)
  }, [annotations, imageHeight, imageWidth])

  const performAction = useCallback(
    async (action: 'copy' | 'save' | 'pin'): Promise<void> => {
      if (busyAction) return
      setBusyAction(action)
      setActionStatus('')
      try {
        const dataUrl = exportedDataUrl()
        if (action === 'copy') {
          await window.brclioShot.copyImage(dataUrl)
          setActionStatus('已复制到剪贴板')
        } else if (action === 'pin') {
          await window.brclioShot.pinImage(dataUrl)
          setActionStatus('已在桌面置顶')
        } else {
          const timestamp = asset.createdAt.replace(/[:.]/g, '-').replace('T', '-')
          const result = await window.brclioShot.save({
            dataUrl,
            suggestedName: `Brclio-Shot-${timestamp}`
          })
          setActionStatus(result.canceled ? '已取消保存' : `已保存${result.filePath ? ` · ${result.filePath}` : ''}`)
        }
      } catch (error) {
        setActionStatus(formatError(error))
      } finally {
        setBusyAction(null)
      }
    },
    [asset.createdAt, busyAction, exportedDataUrl]
  )

  useEffect(() => {
    let active = true
    imageRef.current = null
    setImage(null)
    setImageError(null)
    setAnnotations([])
    setPast([])
    setFuture([])
    setSelectedId(null)
    setTextEntry(null)
    setDraftAnnotation(null)
    fitFollowingRef.current = true

    void loadCanvasImage(asset.dataUrl)
      .then((loadedImage) => {
        if (!active) return
        imageRef.current = loadedImage
        setImage(loadedImage)
      })
      .catch((error: unknown) => {
        if (active) setImageError(formatError(error))
      })

    return () => {
      active = false
    }
  }, [asset.dataUrl, asset.id, setDraftAnnotation])

  useEffect(() => {
    const workspace = workspaceRef.current
    if (!workspace) return

    const calculateFit = (): void => {
      const availableWidth = Math.max(240, workspace.clientWidth - 64)
      const availableHeight = Math.max(180, workspace.clientHeight - 64)
      const nextFit = Math.min(1, availableWidth / imageWidth, availableHeight / imageHeight)
      setFitZoom(nextFit)
      if (fitFollowingRef.current) setZoom(nextFit)
    }

    calculateFit()
    const onResize = (): void => calculateFit()
    window.addEventListener('resize', onResize)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(calculateFit)
    observer?.observe(workspace)
    return () => {
      window.removeEventListener('resize', onResize)
      observer?.disconnect()
    }
  }, [imageHeight, imageWidth])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !image) return
    if (canvas.width !== imageWidth) canvas.width = imageWidth
    if (canvas.height !== imageHeight) canvas.height = imageHeight
    const context = canvas.getContext('2d')
    if (!context) return
    const frame = requestAnimationFrame(() => {
      drawEditorScene(context, image, annotations, {
        imageWidth,
        imageHeight,
        draft,
        selectedId
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [annotations, draft, image, imageHeight, imageWidth, selectedId])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (isEditableTarget(event.target)) return
      const key = event.key.toLowerCase()
      const command = event.metaKey || event.ctrlKey

      if (command && key === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
        return
      }
      if (event.ctrlKey && key === 'y') {
        event.preventDefault()
        redo()
        return
      }
      if (command && key === 'c') {
        event.preventDefault()
        void performAction('copy')
        return
      }
      if (command && key === 's') {
        event.preventDefault()
        void performAction('save')
        return
      }
      if (command && event.shiftKey && key === 'p') {
        event.preventDefault()
        void performAction('pin')
        return
      }
      if (command || event.altKey) return

      if (key === 'escape') {
        event.preventDefault()
        if (gestureRef.current) cancelGesture()
        else onClose?.()
        return
      }
      if (key === 'backspace' || key === 'delete') {
        event.preventDefault()
        deleteSelected()
        return
      }
      if (key === '[') {
        event.preventDefault()
        setStrokeWidth((width) => Math.max(1, width - 1))
        return
      }
      if (key === ']') {
        event.preventDefault()
        setStrokeWidth((width) => Math.min(16, width + 1))
        return
      }
      if (key === '+' || key === '=') {
        event.preventDefault()
        changeZoom(1)
        return
      }
      if (key === '-' || key === '_') {
        event.preventDefault()
        changeZoom(-1)
        return
      }
      if (key === '0') {
        event.preventDefault()
        resetZoom()
        return
      }

      const nextTool = TOOL_SHORTCUTS.get(key)
      if (nextTool) {
        event.preventDefault()
        chooseTool(nextTool)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [cancelGesture, changeZoom, chooseTool, deleteSelected, onClose, performAction, redo, resetZoom, undo])

  const beginPointerGesture = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (event.button !== 0 || !image) return
    const canvas = event.currentTarget
    const point = pointerPoint(event, canvas)
    setActionStatus('')

    if (tool === 'select') {
      const hit = hitTestAnnotation(annotations, point, 8 / Math.max(zoom, 0.05))
      setSelectedId(hit?.id ?? null)
      if (!hit) return
      gestureRef.current = {
        kind: 'move',
        pointerId: event.pointerId,
        base: annotations,
        start: point,
        annotationId: hit.id
      }
      canvas.setPointerCapture?.(event.pointerId)
      return
    }

    setSelectedId(null)
    if (tool === 'text') {
      setTextEntry({ point, value: '' })
      return
    }

    if (tool === 'number') {
      const nextValue = annotations.reduce(
        (maximum, annotation) => annotation.tool === 'number' ? Math.max(maximum, annotation.value) : maximum,
        0
      ) + 1
      const annotation: NumberAnnotation = {
        id: makeId(),
        tool: 'number',
        point,
        value: nextValue,
        color,
        strokeWidth
      }
      commitAnnotations([...annotations, annotation])
      setSelectedId(annotation.id)
      return
    }

    let annotation: Annotation
    if (tool === 'pen' || tool === 'highlighter') {
      annotation = {
        id: makeId(),
        tool,
        points: [point],
        color,
        strokeWidth
      } satisfies PathAnnotation
    } else if (tool === 'line' || tool === 'arrow') {
      annotation = {
        id: makeId(),
        tool,
        start: point,
        end: point,
        color,
        strokeWidth
      } satisfies LineAnnotation
    } else {
      annotation = {
        id: makeId(),
        tool,
        start: point,
        end: point,
        color,
        strokeWidth
      } satisfies BoundsAnnotation
    }

    gestureRef.current = {
      kind: 'draw',
      pointerId: event.pointerId,
      base: annotations,
      start: point
    }
    setDraftAnnotation(annotation)
    canvas.setPointerCapture?.(event.pointerId)
  }

  const movePointerGesture = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    const point = pointerPoint(event, event.currentTarget)

    if (gesture.kind === 'move') {
      const deltaX = point.x - gesture.start.x
      const deltaY = point.y - gesture.start.y
      setAnnotations(
        gesture.base.map((annotation) =>
          annotation.id === gesture.annotationId
            ? translateAnnotation(annotation, deltaX, deltaY)
            : annotation
        )
      )
      return
    }

    const current = draftRef.current
    if (!current) return
    if (current.tool === 'pen' || current.tool === 'highlighter') {
      const lastPoint = current.points[current.points.length - 1]
      if (lastPoint && pointDistance(lastPoint, point) < 0.75) return
      setDraftAnnotation({ ...current, points: [...current.points, point] })
    } else if (
      current.tool === 'crop' ||
      current.tool === 'rectangle' ||
      current.tool === 'ellipse' ||
      current.tool === 'mosaic' ||
      current.tool === 'blur' ||
      current.tool === 'line' ||
      current.tool === 'arrow'
    ) {
      setDraftAnnotation({ ...current, end: point })
    }
  }

  const finishPointerGesture = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    const point = pointerPoint(event, event.currentTarget)
    gestureRef.current = null
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId)
    } catch {
      // The browser may already have released capture after leaving the window.
    }

    if (gesture.kind === 'move') {
      if (pointDistance(gesture.start, point) < 0.5) {
        setAnnotations(gesture.base)
        return
      }
      const deltaX = point.x - gesture.start.x
      const deltaY = point.y - gesture.start.y
      const next = gesture.base.map((annotation) =>
        annotation.id === gesture.annotationId
          ? translateAnnotation(annotation, deltaX, deltaY)
          : annotation
      )
      setAnnotations(next)
      recordPrevious(gesture.base)
      return
    }

    let annotation = draftRef.current
    setDraftAnnotation(null)
    if (!annotation) return
    if (annotation.tool === 'pen' || annotation.tool === 'highlighter') {
      annotation = { ...annotation, points: [...annotation.points, point] }
      if (annotation.points.length < 2 || pointDistance(gesture.start, point) < 1) return
    } else if (
      annotation.tool === 'crop' ||
      annotation.tool === 'rectangle' ||
      annotation.tool === 'ellipse' ||
      annotation.tool === 'mosaic' ||
      annotation.tool === 'blur' ||
      annotation.tool === 'line' ||
      annotation.tool === 'arrow'
    ) {
      annotation = { ...annotation, end: point }
      if (pointDistance(gesture.start, point) < 2) return
    }

    const next = annotation.tool === 'crop'
      ? [...gesture.base.filter((item) => item.tool !== 'crop'), annotation]
      : [...gesture.base, annotation]
    setAnnotations(next)
    recordPrevious(gesture.base)
    setSelectedId(annotation.id)
  }

  const submitText = (event?: FormEvent): void => {
    event?.preventDefault()
    if (!textEntry) return
    const text = textEntry.value.trim()
    if (text) {
      const annotation: TextAnnotation = {
        id: makeId(),
        tool: 'text',
        point: textEntry.point,
        text,
        fontSize: Math.max(18, 14 + strokeWidth * 2),
        color,
        strokeWidth
      }
      commitAnnotations([...annotations, annotation])
      setSelectedId(annotation.id)
    }
    setTextEntry(null)
  }

  const handleTextKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setTextEntry(null)
    } else if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submitText()
    }
  }

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>): void => {
    if (!event.ctrlKey && !event.metaKey) return
    event.preventDefault()
    changeZoom(event.deltaY < 0 ? 1 : -1)
  }

  const canvasCursor = tool === 'select' ? 'default' : tool === 'text' ? 'text' : 'crosshair'
  const toolDisabled = !image || Boolean(imageError)

  return (
    <main className="editor" style={rootStyle} aria-label="Brclio Shot 图片编辑器">
      <header className="editor__topbar">
        <div className="editor__identity">
          <span className="editor__brand">Brclio Shot</span>
          <span className="editor__asset-meta">
            {modeLabel(asset.mode)} · {outputWidth}×{outputHeight}
          </span>
        </div>

        <div className="editor__history-actions" aria-label="历史操作">
          <button
            type="button"
            className="editor__icon-button"
            onClick={undo}
            disabled={past.length === 0}
            title={`撤销 (${modifierLabel}Z)`}
            aria-label="撤销"
          >
            <Undo2 size={18} />
          </button>
          <button
            type="button"
            className="editor__icon-button"
            onClick={redo}
            disabled={future.length === 0}
            title={`重做 (${modifierLabel}Shift Z)`}
            aria-label="重做"
          >
            <Redo2 size={18} />
          </button>
          <button
            type="button"
            className="editor__icon-button"
            onClick={deleteSelected}
            disabled={!selectedAnnotation}
            title="删除选中标注 (Delete)"
            aria-label="删除选中标注"
          >
            <Trash2 size={18} />
          </button>
          <button
            type="button"
            className="editor__text-button"
            onClick={clearAnnotations}
            disabled={annotations.length === 0}
          >
            清空标注
          </button>
        </div>

        <div className="editor__window-actions">
          {onClose ? (
            <button
              type="button"
              className="editor__icon-button editor__close-button"
              onClick={onClose}
              title="关闭 (Esc)"
              aria-label="关闭编辑器"
            >
              <X size={19} />
            </button>
          ) : null}
        </div>
      </header>

      <section className="editor__toolstrip" aria-label="标注工具">
        <div className="editor__tools" role="toolbar" aria-label="工具选择">
          {TOOL_ITEMS.map(({ tool: itemTool, label, shortcut, icon: Icon }) => (
            <button
              key={itemTool}
              type="button"
              className="editor__tool-button"
              data-active={tool === itemTool ? 'true' : 'false'}
              aria-pressed={tool === itemTool}
              aria-label={`${label}，快捷键 ${shortcut}`}
              title={`${label} (${shortcut})`}
              disabled={toolDisabled}
              onClick={() => chooseTool(itemTool)}
            >
              <Icon size={18} strokeWidth={2} />
              <span className="editor__tool-name">{label}</span>
              <kbd className="editor__shortcut" aria-hidden="true">{shortcut}</kbd>
            </button>
          ))}
        </div>

        <div className="editor__stroke-controls" aria-label="颜色和粗细">
          <label className="editor__color-control" title="标注颜色">
            <span className="editor__control-label">颜色</span>
            <input
              type="color"
              value={color}
              onChange={(event) => setColor(event.target.value)}
              aria-label="标注颜色"
            />
          </label>
          <label className="editor__width-control">
            <span className="editor__control-label">粗细</span>
            <input
              type="range"
              min="1"
              max="16"
              step="1"
              value={strokeWidth}
              onChange={(event) => setStrokeWidth(Number(event.target.value))}
              aria-label="线条粗细"
            />
            <output>{strokeWidth}px</output>
            <kbd title="快捷键">[ ]</kbd>
          </label>
        </div>
      </section>

      <div
        ref={workspaceRef}
        className="editor__workspace"
        style={workspaceStyle}
        onWheel={handleWheel}
      >
        <div className="editor__canvas-centering">
          <div
            className="editor__canvas-stage"
            style={{
              position: 'relative',
              flex: 'none',
              width: imageWidth * zoom,
              height: imageHeight * zoom
            }}
          >
            <canvas
              ref={canvasRef}
              className="editor__canvas"
              width={imageWidth}
              height={imageHeight}
              style={{
                display: 'block',
                width: imageWidth * zoom,
                height: imageHeight * zoom,
                cursor: canvasCursor,
                touchAction: 'none'
              }}
              aria-label="截图标注画布"
              onPointerDown={beginPointerGesture}
              onPointerMove={movePointerGesture}
              onPointerUp={finishPointerGesture}
              onPointerCancel={cancelGesture}
            />

            {textEntry ? (
              <form
                className="editor__text-entry"
                style={{
                  position: 'absolute',
                  left: textEntry.point.x * zoom,
                  top: textEntry.point.y * zoom
                }}
                onSubmit={submitText}
              >
                <textarea
                  autoFocus
                  value={textEntry.value}
                  onChange={(event) => setTextEntry({ ...textEntry, value: event.target.value })}
                  onKeyDown={handleTextKeyDown}
                  rows={2}
                  placeholder="输入文字…"
                  aria-label="标注文字"
                />
                <div className="editor__text-entry-actions">
                  <span>Enter 确认 · Shift+Enter 换行</span>
                  <button type="button" onClick={() => setTextEntry(null)}>取消</button>
                  <button type="submit" aria-label="确认文字">
                    <Check size={16} />
                    确认
                  </button>
                </div>
              </form>
            ) : null}
          </div>
        </div>

        {!image && !imageError ? (
          <div className="editor__canvas-state" role="status">正在加载截图…</div>
        ) : null}
        {imageError ? (
          <div className="editor__canvas-state editor__canvas-state--error" role="alert">{imageError}</div>
        ) : null}
      </div>

      <footer className="editor__footer">
        <div className="editor__zoom-controls" aria-label="缩放控制">
          <button
            type="button"
            className="editor__icon-button"
            onClick={() => changeZoom(-1)}
            title="缩小 (-)"
            aria-label="缩小"
          >
            <ZoomOut size={18} />
          </button>
          <button
            type="button"
            className="editor__zoom-value"
            onClick={resetZoom}
            title="适应画布 (0)"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            className="editor__icon-button"
            onClick={() => changeZoom(1)}
            title="放大 (+)"
            aria-label="放大"
          >
            <ZoomIn size={18} />
          </button>
          <span className="editor__output-meta">
            输出 {outputWidth}×{outputHeight} · {annotations.filter((item) => item.tool !== 'crop').length} 个标注
          </span>
        </div>

        <div className="editor__status" role="status" aria-live="polite">
          {busyAction ? '正在处理…' : actionStatus}
        </div>

        <div className="editor__export-actions">
          <button
            type="button"
            className="editor__action-button"
            onClick={() => void performAction('copy')}
            disabled={toolDisabled || Boolean(busyAction)}
            title={`复制 (${modifierLabel}C)`}
          >
            <Copy size={18} />
            复制
          </button>
          <button
            type="button"
            className="editor__action-button"
            onClick={() => void performAction('pin')}
            disabled={toolDisabled || Boolean(busyAction)}
            title={`贴图 (${modifierLabel}Shift P)`}
          >
            <Pin size={18} />
            贴图
          </button>
          <button
            type="button"
            className="editor__action-button editor__action-button--primary"
            onClick={() => void performAction('save')}
            disabled={toolDisabled || Boolean(busyAction)}
            title={`保存到设置路径 (${modifierLabel}S)`}
          >
            <Save size={18} />
            保存
          </button>
        </div>
      </footer>
    </main>
  )
}
