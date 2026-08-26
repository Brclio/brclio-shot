import { randomUUID } from 'node:crypto'
import { BrowserWindow, ipcMain, session, type DesktopCapturerSource, type IpcMainEvent } from 'electron'
import type { CaptureRuntimeFrame } from '../shared/types'
import { IPC_CHANNELS } from '../shared/types'

interface PendingFrame {
  resolve: (frame: CaptureRuntimeFrame) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

type RouteLoader = (window: BrowserWindow, route: string) => Promise<void>

export class CaptureStream {
  private window: BrowserWindow | null = null
  private selectedSource: DesktopCapturerSource | null = null
  private startPromise: Promise<{ width: number; height: number }> | null = null
  private resolveStart: ((size: { width: number; height: number }) => void) | null = null
  private rejectStart: ((error: Error) => void) | null = null
  private startTimer: NodeJS.Timeout | null = null
  private resolveRendererReady: (() => void) | null = null
  private pendingFrames = new Map<string, PendingFrame>()
  private initialized = false

  constructor(
    private readonly preloadPath: string,
    private readonly loadRoute: RouteLoader
  ) {}

  initialize(): void {
    if (this.initialized) return
    this.initialized = true

    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      if (
        this.window &&
        request.frame === this.window.webContents.mainFrame &&
        request.videoRequested &&
        this.selectedSource
      ) {
        callback({ video: this.selectedSource })
        return
      }
      callback({})
    })

    ipcMain.on(IPC_CHANNELS.runtimeReady, (event, size: { width?: unknown; height?: unknown }) => {
      if (!this.isRuntimeEvent(event) || !this.resolveStart) return
      const width = typeof size?.width === 'number' ? size.width : 0
      const height = typeof size?.height === 'number' ? size.height : 0
      if (width < 1 || height < 1) {
        this.failStart(new Error('屏幕流没有返回有效尺寸'))
        return
      }
      this.clearStartTimer()
      const resolve = this.resolveStart
      this.resolveStart = null
      this.rejectStart = null
      resolve({ width, height })
    })

    ipcMain.on(IPC_CHANNELS.runtimeRendererReady, (event) => {
      if (!this.isRuntimeEvent(event) || !this.resolveRendererReady) return
      const resolveReady = this.resolveRendererReady
      this.resolveRendererReady = null
      resolveReady()
    })

    ipcMain.on(IPC_CHANNELS.runtimeFrame, (event, frame: CaptureRuntimeFrame) => {
      if (!this.isRuntimeEvent(event) || !frame || typeof frame.requestId !== 'string') return
      const pending = this.pendingFrames.get(frame.requestId)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pendingFrames.delete(frame.requestId)
      if (!frame.dataUrl.startsWith('data:image/png;base64,') || frame.width < 1 || frame.height < 1) {
        pending.reject(new Error('采集帧格式无效'))
        return
      }
      pending.resolve(frame)
    })

    ipcMain.on(IPC_CHANNELS.runtimeError, (event, message: unknown) => {
      if (!this.isRuntimeEvent(event)) return
      const error = new Error(typeof message === 'string' ? message : '屏幕采集运行时错误')
      this.failStart(error)
      for (const pending of this.pendingFrames.values()) {
        clearTimeout(pending.timer)
        pending.reject(error)
      }
      this.pendingFrames.clear()
    })

    ipcMain.on(IPC_CHANNELS.runtimeStopped, (event) => {
      if (!this.isRuntimeEvent(event)) return
      if (!this.selectedSource) this.startPromise = null
    })
  }

  async start(source: DesktopCapturerSource): Promise<{ width: number; height: number }> {
    await this.stop()
    const runtimeWindow = await this.ensureWindow()
    this.selectedSource = source
    this.startPromise = new Promise((resolve, reject) => {
      this.resolveStart = resolve
      this.rejectStart = reject
      this.startTimer = setTimeout(() => this.failStart(new Error('等待屏幕录制权限或视频帧超时')), 45_000)
      runtimeWindow.webContents.send(IPC_CHANNELS.runtimeStart)
    })
    return this.startPromise
  }

  async grab(): Promise<CaptureRuntimeFrame> {
    if (!this.window || !this.selectedSource || !this.startPromise) throw new Error('屏幕采集流尚未启动')
    await this.startPromise
    const requestId = randomUUID()
    const result = new Promise<CaptureRuntimeFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingFrames.delete(requestId)
        reject(new Error('读取屏幕帧超时'))
      }, 8_000)
      this.pendingFrames.set(requestId, { resolve, reject, timer })
    })
    this.window.webContents.send(IPC_CHANNELS.runtimeGrab, requestId)
    return result
  }

  async capture(source: DesktopCapturerSource): Promise<CaptureRuntimeFrame> {
    await this.start(source)
    try {
      return await this.grab()
    } finally {
      await this.stop()
    }
  }

  async stop(): Promise<void> {
    this.clearStartTimer()
    if (this.window && !this.window.isDestroyed()) this.window.webContents.send(IPC_CHANNELS.runtimeStop)
    this.selectedSource = null
    this.startPromise = null
    this.resolveStart = null
    this.rejectStart = null
    for (const pending of this.pendingFrames.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('屏幕采集已停止'))
    }
    this.pendingFrames.clear()
  }

  destroy(): void {
    void this.stop()
    if (this.window && !this.window.isDestroyed()) this.window.destroy()
    this.window = null
  }

  getWindow(): BrowserWindow | null {
    return this.window && !this.window.isDestroyed() ? this.window : null
  }

  private async ensureWindow(): Promise<BrowserWindow> {
    if (this.window && !this.window.isDestroyed()) return this.window
    const runtimeWindow = new BrowserWindow({
      show: false,
      width: 2,
      height: 2,
      skipTaskbar: true,
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        backgroundThrottling: false
      }
    })
    runtimeWindow.setMenuBarVisibility(false)
    runtimeWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    runtimeWindow.on('closed', () => {
      this.window = null
      this.selectedSource = null
      this.failStart(new Error('屏幕采集运行时已关闭'))
    })
    this.window = runtimeWindow
    const rendererReady = new Promise<void>((resolve) => {
      this.resolveRendererReady = resolve
      setTimeout(() => {
        if (this.resolveRendererReady === resolve) {
          this.resolveRendererReady = null
          resolve()
        }
      }, 8_000)
    })
    await this.loadRoute(runtimeWindow, '/capture-runtime')
    await rendererReady
    return runtimeWindow
  }

  private isRuntimeEvent(event: IpcMainEvent): boolean {
    return Boolean(this.window && !this.window.isDestroyed() && event.sender === this.window.webContents)
  }

  private clearStartTimer(): void {
    if (this.startTimer) clearTimeout(this.startTimer)
    this.startTimer = null
  }

  private failStart(error: Error): void {
    this.clearStartTimer()
    const reject = this.rejectStart
    this.resolveStart = null
    this.rejectStart = null
    this.startPromise = null
    if (reject) reject(error)
  }
}
