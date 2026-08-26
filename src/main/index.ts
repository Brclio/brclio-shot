import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  app,
  BrowserWindow,
  ClipboardItem,
  clipboard,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  protocol,
  screen,
  shell,
  systemPreferences,
  Tray,
  type DesktopCapturerSource,
  type Display,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type Rectangle
} from 'electron'
import sharp from 'sharp'
import type {
  AppSettings,
  CaptureAsset,
  CaptureMode,
  CaptureRect,
  CaptureRequest,
  DesktopSourcePreview,
  DisplaySnapshot,
  OverlaySelectionResult,
  PermissionState,
  SaveRequest,
  ScrollCaptureProgress
} from '../shared/types'
import { IPC_CHANNELS } from '../shared/types'
import { createCaptureEngine } from './capture-engine'
import { CaptureStream } from './capture-stream'
import { HistoryStore } from './history-store'
import { SaveService, decodeImageDataUrl } from './save-service'
import { SettingsStore } from './settings-store'
import { ShortcutRegistry, type ShortcutHandlers } from './shortcut-registry'
import { stitchScrollFrames } from './scroll-stitcher'
import { captureWebpage } from './webpage-capture'

const currentDirectory = dirname(fileURLToPath(import.meta.url))
const preloadPath = join(currentDirectory, '../preload/index.cjs')
const rendererDevelopmentUrl = process.env.ELECTRON_RENDERER_URL
const captureEngine = createCaptureEngine()

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'brclio',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: false,
      stream: true
    }
  }
])

interface FrozenDisplay {
  display: Display
  source: DesktopCapturerSource
  snapshot: DisplaySnapshot
  frameDataUrl: string
  frameWidth: number
  frameHeight: number
}

interface LastRegion {
  displayId: string
  rect: CaptureRect
}

interface ScrollSessionState {
  active: boolean
  frames: Buffer[]
  display: Display
  source: DesktopCapturerSource
  rect: CaptureRect
  frameWidth: number
  frameHeight: number
  loop: Promise<void>
  warnings: string[]
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function normalizeRect(rect: CaptureRect, bounds: { width: number; height: number }): CaptureRect {
  const x1 = Math.max(0, Math.min(bounds.width, Math.min(rect.x, rect.x + rect.width)))
  const y1 = Math.max(0, Math.min(bounds.height, Math.min(rect.y, rect.y + rect.height)))
  const x2 = Math.max(0, Math.min(bounds.width, Math.max(rect.x, rect.x + rect.width)))
  const y2 = Math.max(0, Math.min(bounds.height, Math.max(rect.y, rect.y + rect.height)))
  return {
    x: Math.round(x1),
    y: Math.round(y1),
    width: Math.max(1, Math.round(x2 - x1)),
    height: Math.max(1, Math.round(y2 - y1))
  }
}

function intersects(first: Rectangle, second: Rectangle): boolean {
  return !(
    first.x + first.width <= second.x ||
    second.x + second.width <= first.x ||
    first.y + first.height <= second.y ||
    second.y + second.height <= first.y
  )
}

async function loadRendererRoute(window: BrowserWindow, route: string): Promise<void> {
  if (rendererDevelopmentUrl) {
    await window.loadURL(`${rendererDevelopmentUrl}#${route}`)
  } else {
    await window.loadURL(`brclio://app/index.html#${route}`)
  }
}

async function registerRendererProtocol(): Promise<void> {
  const rendererRoot = app.isPackaged
    ? join(process.resourcesPath, 'renderer')
    : join(app.getAppPath(), 'out/renderer')
  await protocol.handle('brclio', async (request) => {
    try {
      const url = new URL(request.url)
      if (url.hostname !== 'app') return new Response('Not found', { status: 404 })
      const requestedPath = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)
      const filePath = resolve(rendererRoot, `.${requestedPath}`)
      const relation = relative(rendererRoot, filePath)
      if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
        return new Response('Forbidden', { status: 403 })
      }
      const extension = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
      const contentTypes: Record<string, string> = {
        '.css': 'text/css; charset=utf-8',
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.png': 'image/png',
        '.svg': 'image/svg+xml',
        '.webp': 'image/webp'
      }
      const contents = await readFile(filePath)
      return new Response(new Uint8Array(contents), {
        headers: {
          'Content-Type': contentTypes[extension] ?? 'application/octet-stream',
          'Cache-Control': app.isPackaged ? 'public, max-age=31536000, immutable' : 'no-store'
        }
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

function screenPermissionState(): PermissionState {
  if (process.platform !== 'darwin') {
    return { platform: process.platform, screen: 'not-needed', canRequest: true }
  }
  const status = systemPreferences.getMediaAccessStatus('screen')
  const screenStatus: PermissionState['screen'] =
    status === 'granted' || status === 'denied' || status === 'restricted' || status === 'unknown'
      ? status
      : 'unknown'
  return { platform: process.platform, screen: screenStatus, canRequest: status !== 'restricted' }
}

class BrclioShotApplication {
  private mainWindow: BrowserWindow | null = null
  private overlayWindow: BrowserWindow | null = null
  private scrollControllerWindow: BrowserWindow | null = null
  private tray: Tray | null = null
  private settingsStore!: SettingsStore
  private historyStore!: HistoryStore
  private readonly saveService = new SaveService()
  private readonly shortcutRegistry = new ShortcutRegistry()
  private readonly captureStream = new CaptureStream(preloadPath, loadRendererRoute)
  private isQuitting = false
  private overlaySnapshot: DisplaySnapshot | null = null
  private overlayResolve: ((result: OverlaySelectionResult) => void) | null = null
  private scrollSession: ScrollSessionState | null = null
  private lastRegion: LastRegion | null = null
  private captureInProgress = false
  private knownSavedFiles = new Set<string>()
  private pinPayloads = new Map<number, string>()

  async initialize(): Promise<void> {
    app.setName('Brclio Shot')
    this.settingsStore = new SettingsStore(app.getPath('userData'), app.getPath('pictures'))
    this.historyStore = new HistoryStore(app.getPath('userData'))
    const [settings] = await Promise.all([this.settingsStore.load(), this.historyStore.load()])
    nativeTheme.themeSource = settings.theme
    this.applyLoginItemSetting(settings.launchAtLogin)

    this.captureStream.initialize()
    this.registerOverlayIpc()
    this.registerApplicationIpc()
    this.createMainWindow()
    this.createTray()
    this.registerShortcuts()
    this.installApplicationMenu()

    screen.on('display-removed', () => this.cancelActiveSelection('显示器已移除，请重新截图'))
    screen.on('display-metrics-changed', () => this.cancelActiveSelection('显示器参数已变化，请重新截图'))
  }

  showDashboard(section?: 'capture' | 'history' | 'settings'): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) this.createMainWindow()
    const mainWindow = this.mainWindow
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    if (section) mainWindow.webContents.send(IPC_CHANNELS.navigationOpen, section)
  }

  async quit(): Promise<void> {
    this.isQuitting = true
    await this.cancelScrollCapture()
    this.shortcutRegistry.unregisterAll()
    this.captureStream.destroy()
    app.quit()
  }

  prepareToQuit(): void {
    this.isQuitting = true
  }

  private createMainWindow(): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) return
    const isMac = process.platform === 'darwin'
    const window = new BrowserWindow({
      width: 1180,
      height: 780,
      minWidth: 920,
      minHeight: 640,
      show: false,
      backgroundColor: '#f7f3e9',
      title: 'Brclio Shot',
      titleBarStyle: 'hidden',
      titleBarOverlay: isMac
        ? false
        : { color: '#f7f3e9', symbolColor: '#252933', height: 52 },
      trafficLightPosition: isMac ? { x: 18, y: 18 } : undefined,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false
      }
    })
    window.setMenuBarVisibility(false)
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://brclio.com') || url.startsWith('https://github.com/Brclio/')) void shell.openExternal(url)
      return { action: 'deny' }
    })
    window.on('close', (event) => {
      if (!this.isQuitting) {
        event.preventDefault()
        if (this.settingsStore.get().keepInTray) window.hide()
        else void this.quit()
      }
    })
    window.on('closed', () => {
      this.mainWindow = null
    })
    window.once('ready-to-show', () => {
      if (!app.getLoginItemSettings().wasOpenedAtLogin && !process.argv.includes('--hidden')) window.show()
      window.webContents.send(IPC_CHANNELS.shortcutStatus, this.shortcutRegistry.status())
    })
    this.mainWindow = window
    void loadRendererRoute(window, '/dashboard')
  }

  private createTray(): void {
    const iconPath = app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(app.getAppPath(), 'build/icon.png')
    let icon = nativeImage.createFromPath(iconPath)
    if (process.platform === 'darwin') {
      icon = icon.resize({ width: 18, height: 18 })
      icon.setTemplateImage(true)
    } else {
      icon = icon.resize({ width: 24, height: 24 })
    }
    this.tray = new Tray(icon)
    this.tray.setToolTip('Brclio Shot')
    this.tray.on('click', () => this.showDashboard('capture'))
    this.refreshTrayMenu()
  }

  private refreshTrayMenu(): void {
    if (!this.tray) return
    const shortcuts = this.settingsStore.get().shortcuts
    const menu = Menu.buildFromTemplate([
      { label: '打开 Brclio Shot', accelerator: shortcuts.openDashboard, click: () => this.showDashboard('capture') },
      { type: 'separator' },
      { label: '区域截图', accelerator: shortcuts.captureRegion, click: () => void this.runCapture({ mode: 'region' }, true) },
      { label: '窗口截图…', accelerator: shortcuts.captureWindow, click: () => this.showDashboard('capture') },
      {
        label: '全屏截图',
        accelerator: shortcuts.captureFullscreen,
        click: () => void this.runCapture({ mode: 'fullscreen' }, true)
      },
      { label: '长截图', accelerator: shortcuts.captureScroll, click: () => void this.startScrollCapture() },
      { label: '延时截图', accelerator: shortcuts.captureDelay, click: () => void this.runCapture({ mode: 'delay', delaySeconds: 5 }, true) },
      { type: 'separator' },
      { label: '截图历史', accelerator: shortcuts.openHistory, click: () => this.showDashboard('history') },
      { label: '设置', click: () => this.showDashboard('settings') },
      { type: 'separator' },
      { label: '退出 Brclio Shot', click: () => void this.quit() }
    ])
    this.tray.setContextMenu(menu)
  }

  private installApplicationMenu(): void {
    const menu = Menu.buildFromTemplate([
      ...(process.platform === 'darwin'
        ? [
            {
              label: 'Brclio Shot',
              submenu: [
                { role: 'about' as const },
                { type: 'separator' as const },
                { label: '设置…', accelerator: 'Command+,', click: () => this.showDashboard('settings') },
                { type: 'separator' as const },
                { role: 'hide' as const },
                { role: 'hideOthers' as const },
                { type: 'separator' as const },
                { label: '退出 Brclio Shot', accelerator: 'Command+Q', click: () => void this.quit() }
              ]
            }
          ]
        : []),
      {
        label: '编辑',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' }
        ]
      },
      {
        label: '窗口',
        submenu: [{ role: 'minimize' }, { role: 'zoom' }, ...(process.platform === 'darwin' ? [{ role: 'front' as const }] : [])]
      }
    ])
    Menu.setApplicationMenu(menu)
  }

  private registerShortcuts(): void {
    const handlers: ShortcutHandlers = {
      openDashboard: () => this.showDashboard('capture'),
      captureRegion: () => this.runCapture({ mode: 'region' }, true).then(() => undefined),
      captureWindow: () => this.showDashboard('capture'),
      captureFullscreen: () => this.runCapture({ mode: 'fullscreen' }, true).then(() => undefined),
      captureScroll: () => this.startScrollCapture(),
      captureDelay: () => this.runCapture({ mode: 'delay', delaySeconds: 5 }, true).then(() => undefined),
      repeatLastRegion: () => this.repeatLastRegion().then(() => undefined),
      openHistory: () => this.showDashboard('history'),
      stopScrollCapture: () => this.stopScrollCapture().then(() => undefined)
    }
    const status = this.shortcutRegistry.register(this.settingsStore.get(), handlers)
    this.mainWindow?.webContents.send(IPC_CHANNELS.shortcutStatus, status)
  }

  private registerApplicationIpc(): void {
    this.handleDashboard(IPC_CHANNELS.settingsGet, async () => this.settingsStore.get())
    this.handleDashboard(IPC_CHANNELS.settingsUpdate, async (_event, patch: Partial<AppSettings>) => {
      if (!patch || typeof patch !== 'object') throw new Error('设置数据无效')
      const settings = await this.settingsStore.update(patch)
      nativeTheme.themeSource = settings.theme
      this.applyLoginItemSetting(settings.launchAtLogin)
      this.registerShortcuts()
      this.refreshTrayMenu()
      this.mainWindow?.webContents.send(IPC_CHANNELS.settingsChanged, settings)
      return settings
    })
    this.handleDashboard(IPC_CHANNELS.settingsChooseDirectory, async () => {
      const owner = this.mainWindow && !this.mainWindow.isDestroyed() ? this.mainWindow : undefined
      const result = owner
        ? await dialog.showOpenDialog(owner, {
            title: '选择默认截图保存目录',
            defaultPath: this.settingsStore.get().saveDirectory,
            properties: ['openDirectory', 'createDirectory']
          })
        : await dialog.showOpenDialog({
            title: '选择默认截图保存目录',
            defaultPath: this.settingsStore.get().saveDirectory,
            properties: ['openDirectory', 'createDirectory']
          })
      if (result.canceled || !result.filePaths[0]) return null
      const settings = await this.settingsStore.update({ saveDirectory: result.filePaths[0] })
      this.mainWindow?.webContents.send(IPC_CHANNELS.settingsChanged, settings)
      return result.filePaths[0]
    })
    this.handleDashboard(IPC_CHANNELS.permissionGet, async () => screenPermissionState())
    this.handleDashboard(IPC_CHANNELS.permissionRequest, async () => this.requestScreenPermission())
    this.handleDashboard(IPC_CHANNELS.sourcesList, async (_event, kind: 'screen' | 'window') => {
      if (kind !== 'screen' && kind !== 'window') throw new Error('截图来源类型无效')
      const previews = await captureEngine.listSources(kind, { thumbnailSize: { width: 420, height: 260 } })
      return previews.filter((source) => !/^Brclio Shot(?:$|\s)/i.test(source.name))
    })
    this.handleDashboard(IPC_CHANNELS.captureStart, async (_event, request: CaptureRequest) => {
      this.validateCaptureRequest(request)
      return this.runCapture(request, false)
    })
    this.handleDashboard(IPC_CHANNELS.scrollStart, async () => this.startScrollCapture())
    this.handleTrusted(IPC_CHANNELS.scrollStop, async () => this.stopScrollCapture())
    this.handleTrusted(IPC_CHANNELS.scrollCancel, async () => this.cancelScrollCapture())
    this.handleTrusted(IPC_CHANNELS.imageSave, async (_event, request: SaveRequest) => {
      if (!request || typeof request.dataUrl !== 'string') throw new Error('保存请求无效')
      const result = await this.saveService.save(request, this.settingsStore.get(), this.mainWindow)
      if (result.filePath) this.knownSavedFiles.add(resolve(result.filePath))
      return result
    })
    this.handleTrusted(IPC_CHANNELS.imageCopy, async (_event, dataUrl: string) => this.copyImage(dataUrl))
    this.handleTrusted(IPC_CHANNELS.imagePin, async (_event, dataUrl: string) => this.createPinWindow(dataUrl))
    this.handleTrusted(IPC_CHANNELS.pinSetOpacity, async (event, opacity: number) => {
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window || window === this.mainWindow || window === this.overlayWindow) throw new Error('当前窗口不是贴图窗口')
      window.setOpacity(Math.max(0.2, Math.min(1, Number(opacity))))
    })
    this.handleTrusted(IPC_CHANNELS.windowCloseCurrent, async (event) => {
      const window = BrowserWindow.fromWebContents(event.sender)
      if (window && window !== this.mainWindow && !window.isDestroyed()) window.close()
    })
    this.handleDashboard(IPC_CHANNELS.historyGet, async () => this.historyStore.list())
    this.handleDashboard(IPC_CHANNELS.historyOpen, async (_event, id: string) => this.historyStore.open(String(id)))
    this.handleDashboard(IPC_CHANNELS.historyDelete, async (_event, id: string) => this.historyStore.delete(String(id)))
    this.handleDashboard(IPC_CHANNELS.historyClear, async () => this.historyStore.clear())
    this.handleTrusted(IPC_CHANNELS.fileReveal, async (_event, filePath: string) => {
      if (!this.canReveal(filePath)) throw new Error('只能打开由 Brclio Shot 保存的文件')
      shell.showItemInFolder(filePath)
    })
  }

  private registerOverlayIpc(): void {
    ipcMain.on(IPC_CHANNELS.overlayReady, (event) => {
      if (!this.isWindowSender(event, this.overlayWindow) || !this.overlaySnapshot) return
      event.sender.send(IPC_CHANNELS.overlayInit, this.overlaySnapshot)
    })
    ipcMain.on(IPC_CHANNELS.overlayComplete, (event, result: OverlaySelectionResult) => {
      if (!this.isWindowSender(event, this.overlayWindow) || !this.overlayResolve || !this.overlaySnapshot) return
      if (!result || result.displayId !== this.overlaySnapshot.displayId || (!result.canceled && !result.rect)) return
      const resolveSelection = this.overlayResolve
      this.overlayResolve = null
      this.destroyOverlay()
      resolveSelection(result)
    })
    ipcMain.on(IPC_CHANNELS.overlayCancel, (event) => {
      if (!this.isWindowSender(event, this.overlayWindow) || !this.overlayResolve || !this.overlaySnapshot) return
      const resolveSelection = this.overlayResolve
      const displayId = this.overlaySnapshot.displayId
      this.overlayResolve = null
      this.destroyOverlay()
      resolveSelection({ canceled: true, displayId })
    })
    ipcMain.on(IPC_CHANNELS.pinReady, (event) => {
      const payload = this.pinPayloads.get(event.sender.id)
      if (payload) event.sender.send(IPC_CHANNELS.pinInit, payload)
    })
  }

  private handleDashboard(channel: string, handler: (event: IpcMainInvokeEvent, ...args: any[]) => unknown): void {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!this.isWindowSender(event, this.mainWindow)) throw new Error('不受信任的 Brclio Shot 请求来源')
      return handler(event, ...args)
    })
  }

  private handleTrusted(channel: string, handler: (event: IpcMainInvokeEvent, ...args: any[]) => unknown): void {
    ipcMain.handle(channel, async (event, ...args) => {
      const senderWindow = BrowserWindow.fromWebContents(event.sender)
      if (!senderWindow || senderWindow.isDestroyed()) throw new Error('不受信任的 Brclio Shot 请求来源')
      return handler(event, ...args)
    })
  }

  private isWindowSender(event: IpcMainEvent | IpcMainInvokeEvent, window: BrowserWindow | null): boolean {
    return Boolean(window && !window.isDestroyed() && event.sender === window.webContents)
  }

  private validateCaptureRequest(request: CaptureRequest): void {
    const modes: CaptureMode[] = ['region', 'window', 'fullscreen', 'scroll', 'webpage', 'delay']
    if (!request || !modes.includes(request.mode)) throw new Error('截图模式无效')
    if (request.sourceId && (typeof request.sourceId !== 'string' || request.sourceId.length > 300)) throw new Error('窗口来源无效')
    if (request.url && (typeof request.url !== 'string' || request.url.length > 4_000)) throw new Error('网址无效')
    if (request.delaySeconds !== undefined && (!Number.isFinite(request.delaySeconds) || request.delaySeconds < 1 || request.delaySeconds > 30)) {
      throw new Error('延时截图只支持 1–30 秒')
    }
  }

  private async runCapture(request: CaptureRequest, initiatedByShortcut: boolean): Promise<CaptureAsset | null> {
    if (request.mode === 'scroll') {
      await this.startScrollCapture()
      return null
    }
    if (this.captureInProgress || this.scrollSession) {
      if (initiatedByShortcut) this.notify('截图正在进行', '请先完成或取消当前截图。')
      return null
    }
    this.captureInProgress = true
    try {
      let asset: CaptureAsset | null
      switch (request.mode) {
        case 'region':
          asset = await this.captureRegion()
          break
        case 'window':
          if (!request.sourceId) {
            this.showDashboard('capture')
            return null
          }
          asset = await this.captureWindow(request.sourceId)
          break
        case 'fullscreen':
          asset = await this.captureFullscreen()
          break
        case 'delay':
          asset = await this.captureDelayed(request.delaySeconds ?? 5)
          break
        case 'webpage':
          if (!request.url) throw new Error('请输入要捕获的网页地址')
          asset = await this.captureWholeWebpage(request.url)
          break
        default:
          asset = null
      }
      if (asset) await this.deliverAsset(asset, initiatedByShortcut)
      return asset
    } catch (error) {
      this.showDashboard('capture')
      this.notify('截图未完成', errorMessage(error))
      if (!initiatedByShortcut) throw error
      return null
    } finally {
      this.captureInProgress = false
    }
  }

  private async captureRegion(mode: 'region' | 'delay' = 'region'): Promise<CaptureAsset | null> {
    const frozen = await this.freezeActiveDisplay()
    const selection = await this.selectRegion(frozen.snapshot)
    if (selection.canceled || !selection.rect) return null
    const rect = normalizeRect(
      {
        ...selection.rect,
        x: selection.rect.x - frozen.display.bounds.x,
        y: selection.rect.y - frozen.display.bounds.y
      },
      frozen.display.bounds
    )
    this.lastRegion = { displayId: frozen.snapshot.displayId, rect }
    const cropped = await this.cropFrame(frozen.frameDataUrl, rect, frozen.display.bounds, frozen.frameWidth, frozen.frameHeight)
    const metadata = await sharp(cropped).metadata()
    return this.createAsset(mode, cropped, metadata.width ?? 1, metadata.height ?? 1, frozen.source.name)
  }

  private async repeatLastRegion(): Promise<void> {
    if (!this.lastRegion) {
      this.notify('还没有上一区域', '先完成一次区域截图，再使用重复截图快捷键。')
      return
    }
    if (this.captureInProgress || this.scrollSession) return
    this.captureInProgress = true
    try {
      const display = screen.getAllDisplays().find((item) => String(item.id) === this.lastRegion?.displayId)
      if (!display) throw new Error('上次截图所在的显示器已不可用')
      const source = await this.findDisplaySource(display)
      const hiddenWindows = this.hideOwnWindows()
      await wait(120)
      const frame = await this.captureStream.capture(source).finally(() => this.restoreOwnWindows(hiddenWindows))
      const cropped = await this.cropFrame(frame.dataUrl, this.lastRegion.rect, display.bounds, frame.width, frame.height)
      const metadata = await sharp(cropped).metadata()
      const asset = this.createAsset('region', cropped, metadata.width ?? 1, metadata.height ?? 1, source.name)
      await this.deliverAsset(asset, true)
    } catch (error) {
      this.notify('重复截图失败', errorMessage(error))
    } finally {
      this.captureInProgress = false
    }
  }

  private async captureFullscreen(): Promise<CaptureAsset> {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const source = await this.findDisplaySource(display)
    const hiddenWindows = this.hideOwnWindows()
    await wait(140)
    const frame = await this.captureStream.capture(source).finally(() => this.restoreOwnWindows(hiddenWindows))
    return this.createAsset('fullscreen', decodeImageDataUrl(frame.dataUrl), frame.width, frame.height, source.name)
  }

  private async captureDelayed(seconds: number): Promise<CaptureAsset | null> {
    this.mainWindow?.webContents.send(IPC_CHANNELS.captureCountdown, seconds)
    for (let remaining = seconds; remaining > 0; remaining -= 1) {
      this.mainWindow?.webContents.send(IPC_CHANNELS.captureCountdown, remaining)
      await wait(1_000)
    }
    return this.captureRegion('delay')
  }

  private async captureWindow(sourceId: string): Promise<CaptureAsset> {
    const source = await this.findSourceById(sourceId, 'window')
    const hiddenWindows = this.hideOwnWindows()
    await wait(140)
    const frame = await this.captureStream.capture(source).finally(() => this.restoreOwnWindows(hiddenWindows))
    return this.createAsset('window', decodeImageDataUrl(frame.dataUrl), frame.width, frame.height, source.name)
  }

  private async captureWholeWebpage(url: string): Promise<CaptureAsset> {
    const result = await captureWebpage(url)
    return this.createAsset('webpage', result.buffer, result.width, result.height, result.title, result.warnings)
  }

  private async freezeActiveDisplay(): Promise<FrozenDisplay> {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const source = await this.findDisplaySource(display)
    const hiddenWindows = this.hideOwnWindows()
    await wait(140)
    const frame = await this.captureStream
      .capture(source)
      .finally(() => this.restoreOwnWindows(hiddenWindows.filter((window) => window !== this.mainWindow)))
    const snapshot: DisplaySnapshot = {
      displayId: String(display.id),
      dataUrl: frame.dataUrl,
      bounds: { ...display.bounds },
      scaleFactor: Math.min(frame.width / display.bounds.width, frame.height / display.bounds.height),
      imageWidth: frame.width,
      imageHeight: frame.height
    }
    return { display, source, snapshot, frameDataUrl: frame.dataUrl, frameWidth: frame.width, frameHeight: frame.height }
  }

  private async selectRegion(snapshot: DisplaySnapshot): Promise<OverlaySelectionResult> {
    if (this.overlayWindow || this.overlayResolve) throw new Error('截图选区已经打开')
    const display = screen.getAllDisplays().find((item) => String(item.id) === snapshot.displayId)
    if (!display) throw new Error('目标显示器已不可用')
    const overlay = new BrowserWindow({
      ...display.bounds,
      show: false,
      frame: false,
      transparent: false,
      backgroundColor: '#181a20',
      alwaysOnTop: true,
      skipTaskbar: true,
      movable: false,
      resizable: false,
      fullscreenable: false,
      hasShadow: false,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false
      }
    })
    overlay.setAlwaysOnTop(true, process.platform === 'darwin' ? 'screen-saver' : 'pop-up-menu')
    overlay.setContentProtection(true)
    overlay.on('closed', () => {
      if (this.overlayWindow === overlay) this.overlayWindow = null
      if (this.overlayResolve && this.overlaySnapshot) {
        const resolveSelection = this.overlayResolve
        const displayId = this.overlaySnapshot.displayId
        this.overlayResolve = null
        this.overlaySnapshot = null
        resolveSelection({ canceled: true, displayId })
      }
    })
    this.overlayWindow = overlay
    this.overlaySnapshot = snapshot
    await loadRendererRoute(overlay, '/overlay')
    overlay.showInactive()
    overlay.focus()
    return new Promise((resolveSelection) => {
      this.overlayResolve = resolveSelection
    })
  }

  private destroyOverlay(): void {
    this.overlaySnapshot = null
    if (this.overlayWindow && !this.overlayWindow.isDestroyed()) this.overlayWindow.destroy()
    this.overlayWindow = null
  }

  private cancelActiveSelection(message: string): void {
    if (this.overlayResolve && this.overlaySnapshot) {
      const resolveSelection = this.overlayResolve
      const displayId = this.overlaySnapshot.displayId
      this.overlayResolve = null
      this.destroyOverlay()
      resolveSelection({ canceled: true, displayId })
      this.notify('截图已取消', message)
    }
    if (this.scrollSession) void this.cancelScrollCapture()
  }

  private async startScrollCapture(): Promise<void> {
    if (this.scrollSession || this.captureInProgress) {
      this.notify('截图正在进行', '请先完成当前截图。')
      return
    }
    this.captureInProgress = true
    try {
      this.emitScrollProgress({ state: 'selecting', frameCount: 0, uniqueFrameCount: 0, message: '拖动选择要拼接的滚动区域' })
      const frozen = await this.freezeActiveDisplay()
      const selection = await this.selectRegion(frozen.snapshot)
      if (selection.canceled || !selection.rect) return
      const rect = normalizeRect(
        {
          ...selection.rect,
          x: selection.rect.x - frozen.display.bounds.x,
          y: selection.rect.y - frozen.display.bounds.y
        },
        frozen.display.bounds
      )
      if (rect.width < 80 || rect.height < 80) throw new Error('长截图选区至少需要 80×80 像素')
      this.lastRegion = { displayId: frozen.snapshot.displayId, rect }
      await this.captureStream.start(frozen.source)
      const state: ScrollSessionState = {
        active: true,
        frames: [],
        display: frozen.display,
        source: frozen.source,
        rect,
        frameWidth: frozen.frameWidth,
        frameHeight: frozen.frameHeight,
        loop: Promise.resolve(),
        warnings: []
      }
      this.scrollSession = state
      await this.createScrollController(state)
      state.loop = this.sampleScrollFrames(state)
    } catch (error) {
      await this.captureStream.stop()
      this.scrollSession = null
      this.emitScrollProgress({
        state: 'error',
        frameCount: 0,
        uniqueFrameCount: 0,
        message: '长截图未能开始',
        error: errorMessage(error)
      })
      this.notify('长截图未能开始', errorMessage(error))
      throw error
    } finally {
      this.captureInProgress = false
    }
  }

  private async sampleScrollFrames(state: ScrollSessionState): Promise<void> {
    const settings = this.settingsStore.get()
    this.emitScrollProgress({
      state: 'capturing',
      frameCount: 0,
      uniqueFrameCount: 0,
      message: '请在目标应用中缓慢向下滚动；完成后按结束快捷键'
    })
    while (state.active && state.frames.length < settings.scrollMaxFrames) {
      const controllerIntersects = this.controllerIntersectsSelection(state)
      if (controllerIntersects && this.scrollControllerWindow && !this.scrollControllerWindow.isDestroyed()) {
        this.scrollControllerWindow.setOpacity(0)
        await wait(80)
      }
      try {
        const frame = await this.captureStream.grab()
        state.frameWidth = frame.width
        state.frameHeight = frame.height
        const crop = await this.cropFrame(frame.dataUrl, state.rect, state.display.bounds, frame.width, frame.height)
        state.frames.push(crop)
      } catch (error) {
        state.active = false
        state.warnings.push(errorMessage(error))
        break
      } finally {
        if (this.scrollControllerWindow && !this.scrollControllerWindow.isDestroyed()) this.scrollControllerWindow.setOpacity(1)
      }
      this.emitScrollProgress({
        state: 'capturing',
        frameCount: state.frames.length,
        uniqueFrameCount: state.frames.length,
        message:
          state.frames.length >= settings.scrollMaxFrames
            ? '已达到帧数上限，请结束并拼接'
            : '正在采样，继续缓慢向下滚动'
      })
      await wait(settings.scrollIntervalMs)
    }
  }

  private async stopScrollCapture(): Promise<CaptureAsset | null> {
    const state = this.scrollSession
    if (!state) return null
    state.active = false
    await state.loop.catch(() => undefined)
    await this.captureStream.stop()
    this.destroyScrollController()
    this.emitScrollProgress({
      state: 'stitching',
      frameCount: state.frames.length,
      uniqueFrameCount: state.frames.length,
      message: '正在分析重叠区域并拼接长图…'
    })
    try {
      const settings = this.settingsStore.get()
      const result = await stitchScrollFrames(state.frames, {
        maxFrames: settings.scrollMaxFrames,
        maxOutputHeight: 100_000,
        maxOutputPixels: 200_000_000,
        reliabilityThreshold: settings.scrollOverlapThreshold,
        similarityThreshold: Math.max(0.72, settings.scrollOverlapThreshold),
        widthMismatchStrategy: 'crop-to-smallest',
        unreliableOverlapStrategy: 'reject',
        detectStaticEdges: true
      })
      const asset = this.createAsset(
        'scroll',
        result.buffer,
        result.width,
        result.height,
        state.source.name,
        [...state.warnings, ...result.warnings],
        result.uniqueFrameCount
      )
      this.scrollSession = null
      this.emitScrollProgress({
        state: 'completed',
        frameCount: result.frameCount,
        uniqueFrameCount: result.uniqueFrameCount,
        message: `长截图完成：${result.width}×${result.height}`
      })
      await this.deliverAsset(asset, true)
      return asset
    } catch (error) {
      this.scrollSession = null
      this.emitScrollProgress({
        state: 'error',
        frameCount: state.frames.length,
        uniqueFrameCount: state.frames.length,
        message: '重叠区域置信度不足，已停止以避免生成错缝图片',
        error: errorMessage(error)
      })
      this.notify('长截图拼接失败', `${errorMessage(error)}。请回退一点并减慢滚动速度后重试。`)
      throw error
    }
  }

  private async cancelScrollCapture(): Promise<void> {
    const state = this.scrollSession
    if (!state) return
    state.active = false
    await state.loop.catch(() => undefined)
    await this.captureStream.stop()
    this.scrollSession = null
    this.destroyScrollController()
    this.emitScrollProgress({
      state: 'canceled',
      frameCount: state.frames.length,
      uniqueFrameCount: state.frames.length,
      message: '长截图已取消，临时帧已清理'
    })
  }

  private async createScrollController(state: ScrollSessionState): Promise<void> {
    this.destroyScrollController()
    const width = 356
    const height = 86
    const displayBounds = state.display.bounds
    const globalSelection: Rectangle = {
      x: displayBounds.x + state.rect.x,
      y: displayBounds.y + state.rect.y,
      width: state.rect.width,
      height: state.rect.height
    }
    const candidates: Rectangle[] = [
      { x: displayBounds.x + displayBounds.width - width - 18, y: displayBounds.y + 18, width, height },
      { x: displayBounds.x + displayBounds.width - width - 18, y: displayBounds.y + displayBounds.height - height - 18, width, height },
      { x: displayBounds.x + 18, y: displayBounds.y + 18, width, height }
    ]
    const bounds = candidates.find((candidate) => !intersects(candidate, globalSelection)) ?? candidates[0]
    const controller = new BrowserWindow({
      ...bounds,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      alwaysOnTop: true,
      resizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: true,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true
      }
    })
    controller.setContentProtection(true)
    controller.setAlwaysOnTop(true, process.platform === 'darwin' ? 'floating' : 'pop-up-menu')
    controller.on('closed', () => {
      if (this.scrollControllerWindow === controller) this.scrollControllerWindow = null
    })
    this.scrollControllerWindow = controller
    await loadRendererRoute(controller, '/scroll-controller')
    controller.showInactive()
  }

  private destroyScrollController(): void {
    if (this.scrollControllerWindow && !this.scrollControllerWindow.isDestroyed()) this.scrollControllerWindow.destroy()
    this.scrollControllerWindow = null
  }

  private controllerIntersectsSelection(state: ScrollSessionState): boolean {
    if (!this.scrollControllerWindow || this.scrollControllerWindow.isDestroyed()) return false
    const selection: Rectangle = {
      x: state.display.bounds.x + state.rect.x,
      y: state.display.bounds.y + state.rect.y,
      width: state.rect.width,
      height: state.rect.height
    }
    return intersects(this.scrollControllerWindow.getBounds(), selection)
  }

  private emitScrollProgress(progress: ScrollCaptureProgress): void {
    this.mainWindow?.webContents.send(IPC_CHANNELS.scrollProgress, progress)
    this.scrollControllerWindow?.webContents.send(IPC_CHANNELS.scrollProgress, progress)
  }

  private async deliverAsset(asset: CaptureAsset, sendToDashboard: boolean): Promise<void> {
    const settings = this.settingsStore.get()
    await this.historyStore.add(asset, settings.historyLimit).catch((error) => {
      asset.warnings = [...(asset.warnings ?? []), `历史记录写入失败：${errorMessage(error)}`]
    })

    if (settings.afterCapture === 'clipboard') {
      await this.copyImage(asset.dataUrl)
      this.notify('已复制到剪贴板', `${asset.width}×${asset.height}`)
      return
    }
    if (settings.afterCapture === 'save') {
      const result = await this.saveService.save({ dataUrl: asset.dataUrl }, settings, this.mainWindow, asset.mode)
      if (result.filePath) {
        asset.filePath = result.filePath
        this.knownSavedFiles.add(resolve(result.filePath))
        if (settings.copyAfterSave) await this.copyImage(asset.dataUrl)
        this.notify('截图已保存', result.filePath)
      }
      return
    }

    this.showDashboard('capture')
    if (sendToDashboard) this.mainWindow?.webContents.send(IPC_CHANNELS.captureResult, asset)
  }

  private createAsset(
    mode: CaptureMode,
    buffer: Buffer,
    width: number,
    height: number,
    sourceName?: string,
    warnings?: string[],
    frameCount?: number
  ): CaptureAsset {
    return {
      id: randomUUID(),
      mode,
      createdAt: new Date().toISOString(),
      width,
      height,
      dataUrl: `data:image/png;base64,${buffer.toString('base64')}`,
      sourceName,
      warnings: warnings?.filter(Boolean),
      frameCount
    }
  }

  private async cropFrame(
    dataUrl: string,
    rectDip: CaptureRect,
    displayBounds: Rectangle,
    frameWidth: number,
    frameHeight: number
  ): Promise<Buffer> {
    const rect = normalizeRect(rectDip, displayBounds)
    const ratioX = frameWidth / displayBounds.width
    const ratioY = frameHeight / displayBounds.height
    const left = Math.max(0, Math.min(frameWidth - 1, Math.round(rect.x * ratioX)))
    const top = Math.max(0, Math.min(frameHeight - 1, Math.round(rect.y * ratioY)))
    const width = Math.max(1, Math.min(frameWidth - left, Math.round(rect.width * ratioX)))
    const height = Math.max(1, Math.min(frameHeight - top, Math.round(rect.height * ratioY)))
    return sharp(decodeImageDataUrl(dataUrl), { limitInputPixels: 220_000_000 })
      .extract({ left, top, width, height })
      .png()
      .toBuffer()
  }

  private async findDisplaySource(display: Display): Promise<DesktopCapturerSource> {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
    const direct = sources.find((source) => source.display_id === String(display.id))
    if (direct) return direct
    const byId = sources.find((source) => source.id.startsWith(`screen:${display.id}:`))
    if (byId) return byId
    if (sources.length === 1) return sources[0]
    throw new Error(`找不到显示器 ${display.id} 的截图来源`)
  }

  private async findSourceById(sourceId: string, kind: 'screen' | 'window'): Promise<DesktopCapturerSource> {
    const sources = await desktopCapturer.getSources({ types: [kind], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false })
    const source = sources.find((item) => item.id === sourceId)
    if (!source) throw new Error('目标窗口已经关闭或不可用')
    if (/^Brclio Shot(?:$|\s)/i.test(source.name)) throw new Error('不能截取 Brclio Shot 自身窗口')
    return source
  }

  private async copyImage(dataUrl: string): Promise<void> {
    const buffer = decodeImageDataUrl(dataUrl)
    const blob = new Blob([new Uint8Array(buffer)], { type: 'image/png' })
    await clipboard.write([new ClipboardItem({ 'image/png': blob })])
  }

  private async createPinWindow(dataUrl: string): Promise<void> {
    const buffer = decodeImageDataUrl(dataUrl)
    const metadata = await sharp(buffer, { limitInputPixels: 220_000_000 }).metadata()
    const sourceWidth = metadata.width ?? 480
    const sourceHeight = metadata.height ?? 320
    const workArea = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workAreaSize
    const scale = Math.min(1, (workArea.width * 0.68) / sourceWidth, (workArea.height * 0.68) / sourceHeight)
    const width = Math.max(180, Math.round(sourceWidth * scale))
    const height = Math.max(120, Math.round(sourceHeight * scale))
    const pin = new BrowserWindow({
      width,
      height,
      minWidth: 120,
      minHeight: 80,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      alwaysOnTop: true,
      resizable: true,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: true,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true
      }
    })
    pin.setAlwaysOnTop(true, process.platform === 'darwin' ? 'floating' : 'pop-up-menu')
    pin.setAspectRatio(sourceWidth / sourceHeight)
    const pinWebContentsId = pin.webContents.id
    this.pinPayloads.set(pinWebContentsId, dataUrl)
    pin.on('closed', () => this.pinPayloads.delete(pinWebContentsId))
    await loadRendererRoute(pin, '/pin')
    pin.show()
  }

  private hideOwnWindows(): BrowserWindow[] {
    const hiddenWindows: BrowserWindow[] = []
    for (const window of BrowserWindow.getAllWindows()) {
      if (window !== this.captureRuntimeWindow() && window.isVisible()) {
        hiddenWindows.push(window)
        window.hide()
      }
    }
    return hiddenWindows
  }

  private restoreOwnWindows(windows: BrowserWindow[]): void {
    for (const window of windows) {
      if (!window.isDestroyed() && window !== this.overlayWindow && window !== this.scrollControllerWindow) window.showInactive()
    }
  }

  private captureRuntimeWindow(): BrowserWindow | null {
    return this.captureStream.getWindow()
  }

  private applyLoginItemSetting(openAtLogin: boolean): void {
    app.setLoginItemSettings(
      process.platform === 'win32'
        ? { openAtLogin, path: process.execPath, args: ['--hidden'] }
        : { openAtLogin }
    )
  }

  private async requestScreenPermission(): Promise<PermissionState> {
    const before = screenPermissionState()
    if (process.platform !== 'darwin') return before
    if (before.screen === 'denied' || before.screen === 'restricted') {
      await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
      return before
    }
    try {
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
      const source = await this.findDisplaySource(display)
      await this.captureStream.start(source)
      await this.captureStream.grab()
    } catch {
      // The next status check reflects the OS decision when available.
    } finally {
      await this.captureStream.stop()
    }
    return screenPermissionState()
  }

  private canReveal(filePath: string): boolean {
    if (typeof filePath !== 'string' || !isAbsolute(filePath)) return false
    const normalized = resolve(filePath)
    if (this.knownSavedFiles.has(normalized)) return true
    const saveRoot = resolve(this.settingsStore.get().saveDirectory)
    const relation = relative(saveRoot, normalized)
    return relation !== '' && !relation.startsWith(`..${sep}`) && relation !== '..' && !isAbsolute(relation)
  }

  private notify(title: string, body: string): void {
    if (!this.settingsStore.get().showNotifications || !Notification.isSupported()) return
    new Notification({ title, body: body.slice(0, 280), silent: true }).show()
  }
}

const singleInstance = app.requestSingleInstanceLock()

if (!singleInstance) {
  app.quit()
} else {
  const application = new BrclioShotApplication()
  app.on('second-instance', () => application.showDashboard('capture'))
  app.on('activate', () => application.showDashboard('capture'))
  app.on('before-quit', () => application.prepareToQuit())
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      // The tray keeps the process available unless the user explicitly quits.
    }
  })
  void app
    .whenReady()
    .then(async () => {
      await registerRendererProtocol()
      await application.initialize()
    })
    .catch((error) => {
      dialog.showErrorBox('Brclio Shot 启动失败', errorMessage(error))
      app.quit()
    })
}
