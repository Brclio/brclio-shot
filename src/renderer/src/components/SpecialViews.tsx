import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  Copy,
  Image as ImageIcon,
  Minus,
  MousePointer2,
  Pin,
  Plus,
  Save,
  Square,
  X
} from 'lucide-react'
import type {
  CaptureRect,
  DisplaySnapshot,
  Point,
  ScrollCaptureProgress
} from '../../../shared/types'
import {
  clampRect,
  moveRect,
  rectFromPoints,
  resizeRect,
  type ResizeHandle
} from '../lib/selection'

const handles: ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

function pointFromPointer(event: React.PointerEvent): Point {
  return { x: event.clientX, y: event.clientY }
}

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  )
}

type OverlayInteraction =
  | { kind: 'create'; start: Point }
  | { kind: 'move'; start: Point; origin: CaptureRect }
  | { kind: 'resize'; handle: ResizeHandle; origin: CaptureRect }

export function CaptureOverlay(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<DisplaySnapshot | null>(null)
  const [selection, setSelection] = useState<CaptureRect | null>(null)
  const [pointer, setPointer] = useState<Point>({ x: 0, y: 0 })
  const [spaceHeld, setSpaceHeld] = useState(false)
  const [interaction, setInteraction] = useState<OverlayInteraction | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const api = window.brclioShot
    const unsubscribe = api.onOverlayInit((nextSnapshot) => {
      setSnapshot(nextSnapshot)
      setSelection(null)
    })
    api.overlayReady()
    return unsubscribe
  }, [])

  const cancel = useCallback(() => window.brclioShot.cancelOverlay(), [])
  const complete = useCallback(() => {
    if (!snapshot || !selection || selection.width < 2 || selection.height < 2) return
    window.brclioShot.completeOverlay({
      canceled: false,
      displayId: snapshot.displayId,
      rect: {
        x: snapshot.bounds.x + selection.x,
        y: snapshot.bounds.y + selection.y,
        width: selection.width,
        height: selection.height
      }
    })
  }, [selection, snapshot])

  useEffect(() => {
    const keyDown = (event: KeyboardEvent): void => {
      if (isEditableTarget(event.target)) return
      if (event.code === 'Space') {
        event.preventDefault()
        setSpaceHeld(true)
      }
      if (event.key === 'Escape') cancel()
      if (event.key === 'Enter') complete()
      if (!selection || !snapshot || !event.key.startsWith('Arrow')) return

      event.preventDefault()
      const step = event.shiftKey ? 10 : 1
      const delta: Point = { x: 0, y: 0 }
      if (event.key === 'ArrowLeft') delta.x = -step
      if (event.key === 'ArrowRight') delta.x = step
      if (event.key === 'ArrowUp') delta.y = -step
      if (event.key === 'ArrowDown') delta.y = step
      setSelection(moveRect(selection, delta, snapshot.bounds.width, snapshot.bounds.height))
    }
    const keyUp = (event: KeyboardEvent): void => {
      if (event.code === 'Space') setSpaceHeld(false)
    }
    window.addEventListener('keydown', keyDown)
    window.addEventListener('keyup', keyUp)
    return () => {
      window.removeEventListener('keydown', keyDown)
      window.removeEventListener('keyup', keyUp)
    }
  }, [cancel, complete, selection, snapshot])

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!snapshot || event.button !== 0) return
    const point = pointFromPointer(event)
    const handle = (event.target as HTMLElement).dataset.handle as ResizeHandle | undefined
    rootRef.current?.setPointerCapture(event.pointerId)

    if (selection && handle) {
      setInteraction({ kind: 'resize', handle, origin: selection })
      return
    }

    const target = event.target as HTMLElement
    if (selection && (spaceHeld || target.closest('.capture-selection'))) {
      setInteraction({ kind: 'move', start: point, origin: selection })
      return
    }

    setSelection({ x: point.x, y: point.y, width: 1, height: 1 })
    setInteraction({ kind: 'create', start: point })
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!snapshot) return
    const point = pointFromPointer(event)
    setPointer(point)
    if (!interaction) return

    if (interaction.kind === 'create') {
      let next = rectFromPoints(interaction.start, point)
      if (event.shiftKey) {
        const size = Math.max(next.width, next.height)
        const end = {
          x: interaction.start.x + Math.sign(point.x - interaction.start.x || 1) * size,
          y: interaction.start.y + Math.sign(point.y - interaction.start.y || 1) * size
        }
        next = rectFromPoints(interaction.start, end)
      }
      setSelection(clampRect(next, snapshot.bounds.width, snapshot.bounds.height))
      return
    }

    if (interaction.kind === 'move') {
      setSelection(
        moveRect(
          interaction.origin,
          { x: point.x - interaction.start.x, y: point.y - interaction.start.y },
          snapshot.bounds.width,
          snapshot.bounds.height
        )
      )
      return
    }

    setSelection(
      resizeRect(
        interaction.origin,
        interaction.handle,
        point,
        snapshot.bounds.width,
        snapshot.bounds.height,
        event.shiftKey ? interaction.origin.width / interaction.origin.height : undefined
      )
    )
  }

  const finishPointer = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (rootRef.current?.hasPointerCapture(event.pointerId)) {
      rootRef.current.releasePointerCapture(event.pointerId)
    }
    setInteraction(null)
  }

  const imageStyle = snapshot
    ? ({ backgroundImage: `url(${snapshot.dataUrl})` } as React.CSSProperties)
    : undefined
  const magnifierStyle = snapshot
    ? ({
        left: Math.min(window.innerWidth - 154, pointer.x + 22),
        top: Math.max(16, pointer.y - 146),
        backgroundImage: `url(${snapshot.dataUrl})`,
        backgroundSize: `${window.innerWidth * 8}px ${window.innerHeight * 8}px`,
        backgroundPosition: `${-pointer.x * 8 + 70}px ${-pointer.y * 8 + 70}px`
      } as React.CSSProperties)
    : undefined

  return (
    <div
      className={`capture-overlay ${spaceHeld ? 'is-moving' : ''}`}
      ref={rootRef}
      style={imageStyle}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishPointer}
      onPointerCancel={finishPointer}
      role="application"
      aria-label="截图选区"
    >
      {!snapshot ? (
        <div className="overlay-loading">正在准备冻结画面…</div>
      ) : (
        <>
          <div className="overlay-shade" />
          {selection && (
            <div
              className="capture-selection"
              style={{
                left: selection.x,
                top: selection.y,
                width: selection.width,
                height: selection.height,
                backgroundImage: `url(${snapshot.dataUrl})`,
                backgroundSize: `${window.innerWidth}px ${window.innerHeight}px`,
                backgroundPosition: `${-selection.x}px ${-selection.y}px`
              }}
            >
              {handles.map((handle) => (
                <span key={handle} className={`selection-handle handle-${handle}`} data-handle={handle} />
              ))}
              <div className="selection-readout" style={selection.y < 50 ? { top: 8 } : undefined}>
                <strong>{selection.width} × {selection.height}</strong>
                <span>x {snapshot.bounds.x + selection.x} · y {snapshot.bounds.y + selection.y}</span>
              </div>
              <div className="selection-actions" style={selection.y + selection.height > window.innerHeight - 52 ? { bottom: 8 } : undefined}>
                <button type="button" onPointerDown={(event) => event.stopPropagation()} onClick={cancel} aria-label="取消截图"><X size={17} /></button>
                <button type="button" className="confirm" onPointerDown={(event) => event.stopPropagation()} onClick={complete} aria-label="确认截图"><Check size={17} /></button>
              </div>
            </div>
          )}
          <div className="pixel-magnifier" style={magnifierStyle} aria-hidden="true">
            <span className="magnifier-crosshair" />
            <small>{Math.round(pointer.x)}, {Math.round(pointer.y)}</small>
          </div>
          <div className="overlay-help">
            <MousePointer2 size={16} /> 拖拽选择 · Space 移动 · Shift 锁定比例 · 方向键微调 · Enter 完成 · Esc 取消
          </div>
        </>
      )}
    </div>
  )
}

const initialProgress: ScrollCaptureProgress = {
  state: 'selecting',
  frameCount: 0,
  uniqueFrameCount: 0,
  message: '在目标窗口中滚动，Brclio Shot 会自动拼接'
}

export function ScrollController(): React.JSX.Element {
  const [progress, setProgress] = useState(initialProgress)
  const [busy, setBusy] = useState<'stop' | 'cancel' | null>(null)

  useEffect(() => window.brclioShot.onScrollProgress(setProgress), [])

  const stop = async (): Promise<void> => {
    setBusy('stop')
    try {
      await window.brclioShot.stopScrollCapture()
    } finally {
      setBusy(null)
    }
  }
  const cancel = async (): Promise<void> => {
    setBusy('cancel')
    try {
      await window.brclioShot.cancelScrollCapture()
    } finally {
      setBusy(null)
    }
  }

  const percent = Math.min(92, Math.max(8, progress.uniqueFrameCount * 8))
  return (
    <main className="scroll-controller" aria-live="polite">
      <div className="scroll-controller__mark"><span /></div>
      <div className="scroll-controller__copy">
        <strong>{progress.state === 'stitching' ? '正在拼接' : '长截图进行中'}</strong>
        <span>{progress.message}</span>
      </div>
      <div className="scroll-controller__meter" aria-label={`已采集 ${progress.uniqueFrameCount} 帧`}>
        <span style={{ width: `${percent}%` }} />
      </div>
      <div className="scroll-controller__count">{progress.uniqueFrameCount}<small> 帧</small></div>
      <button type="button" className="controller-stop" onClick={stop} disabled={busy !== null}>
        <Square size={13} fill="currentColor" /> {busy === 'stop' ? '处理中' : '完成'}
      </button>
      <button type="button" className="icon-button controller-cancel" onClick={cancel} disabled={busy !== null} aria-label="取消长截图">
        <X size={17} />
      </button>
    </main>
  )
}

export function PinWindow(): React.JSX.Element {
  const [dataUrl, setDataUrl] = useState('')
  const [opacity, setOpacity] = useState(1)
  const [scale, setScale] = useState(1)
  const [showTools, setShowTools] = useState(false)

  useEffect(() => {
    const unsubscribe = window.brclioShot.onPinInit(setDataUrl)
    window.brclioShot.pinReady()
    return unsubscribe
  }, [])

  const save = async (): Promise<void> => {
    if (dataUrl) await window.brclioShot.save({ dataUrl, chooseLocation: true })
  }
  const copy = async (): Promise<void> => {
    if (dataUrl) await window.brclioShot.copyImage(dataUrl)
  }
  const updateOpacity = (nextOpacity: number): void => {
    setOpacity(nextOpacity)
    void window.brclioShot.setPinOpacity(nextOpacity)
  }

  return (
    <main
      className="pin-window"
      onMouseEnter={() => setShowTools(true)}
      onMouseLeave={() => setShowTools(false)}
      onWheel={(event) => {
        event.preventDefault()
        setScale((current) => Math.min(3, Math.max(0.25, current + (event.deltaY < 0 ? 0.1 : -0.1))))
      }}
    >
      <div className="pin-drag-strip"><Pin size={13} /> Brclio Shot 贴图</div>
      {dataUrl ? (
        <div className="pin-image-stage">
          <img src={dataUrl} alt="置顶截图" style={{ transform: `scale(${scale})` }} />
        </div>
      ) : (
        <div className="pin-empty"><ImageIcon size={28} /> 正在载入贴图…</div>
      )}
      <div className={`pin-toolbar ${showTools ? 'is-visible' : ''}`}>
        <button type="button" onClick={() => setScale((value) => Math.max(0.25, value - 0.1))} aria-label="缩小"><Minus size={15} /></button>
        <button type="button" onClick={() => setScale(1)} className="pin-zoom">{Math.round(scale * 100)}%</button>
        <button type="button" onClick={() => setScale((value) => Math.min(3, value + 0.1))} aria-label="放大"><Plus size={15} /></button>
        <span className="pin-divider" />
        <label className="pin-opacity" title="透明度">
          <span>{Math.round(opacity * 100)}%</span>
          <input type="range" min="40" max="100" value={opacity * 100} onChange={(event) => updateOpacity(Number(event.target.value) / 100)} />
        </label>
        <button type="button" onClick={copy} aria-label="复制"><Copy size={15} /></button>
        <button type="button" onClick={save} aria-label="保存"><Save size={15} /></button>
        <button type="button" onClick={() => void window.brclioShot.closeCurrentWindow()} aria-label="关闭"><X size={15} /></button>
      </div>
    </main>
  )
}

export function CaptureRuntime(): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [state, setState] = useState<'waiting' | 'sharing' | 'error'>('waiting')

  const stopTracks = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
  }, [])

  useEffect(() => {
    const runtime = window.brclioRuntime
    const start = async (): Promise<void> => {
      stopTracks()
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: { ideal: 30, max: 60 } },
          audio: false
        })
        streamRef.current = stream
        const video = videoRef.current
        if (!video) throw new Error('采集视频容器未准备好')
        video.srcObject = stream
        if (!video.videoWidth || !video.videoHeight) {
          await new Promise<void>((resolve, reject) => {
            const cleanup = (): void => {
              video.removeEventListener('loadedmetadata', loaded)
              video.removeEventListener('error', failed)
            }
            const loaded = (): void => {
              cleanup()
              resolve()
            }
            const failed = (): void => {
              cleanup()
              reject(new Error('系统无法读取屏幕画面'))
            }
            video.addEventListener('loadedmetadata', loaded, { once: true })
            video.addEventListener('error', failed, { once: true })
          })
        }
        await video.play()
        if (!video.videoWidth || !video.videoHeight) throw new Error('系统没有返回有效的画面尺寸')
        setState('sharing')
        runtime.ready({ width: video.videoWidth, height: video.videoHeight })
        stream.getVideoTracks()[0]?.addEventListener('ended', () => {
          stopTracks()
          runtime.stopped()
          setState('waiting')
        }, { once: true })
      } catch (error) {
        stopTracks()
        setState('error')
        runtime.error(error instanceof Error ? error.message : '无法开始屏幕采集')
      }
    }

    const grab = (requestId: string): void => {
      const video = videoRef.current
      if (!video || !video.videoWidth || !video.videoHeight) {
        runtime.error('屏幕画面尚未准备好')
        return
      }
      try {
        const canvas = document.createElement('canvas')
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
        const context = canvas.getContext('2d', { alpha: false })
        if (!context) throw new Error('无法创建采集画布')
        context.drawImage(video, 0, 0, canvas.width, canvas.height)
        runtime.frame({
          requestId,
          dataUrl: canvas.toDataURL('image/png'),
          width: canvas.width,
          height: canvas.height
        })
      } catch (error) {
        runtime.error(error instanceof Error ? error.message : '抓取当前帧失败')
      }
    }

    const stop = (): void => {
      stopTracks()
      runtime.stopped()
      setState('waiting')
    }

    const offStart = runtime.onStart(() => void start())
    const offGrab = runtime.onGrab(grab)
    const offStop = runtime.onStop(stop)
    runtime.rendererReady()
    return () => {
      offStart()
      offGrab()
      offStop()
      stopTracks()
    }
  }, [stopTracks])

  const label = useMemo(() => {
    if (state === 'sharing') return '屏幕采集已连接'
    if (state === 'error') return '屏幕采集连接失败'
    return '等待屏幕采集请求'
  }, [state])

  return (
    <main className="capture-runtime" aria-label={label}>
      <video ref={videoRef} muted playsInline />
      <span>{label}</span>
    </main>
  )
}
