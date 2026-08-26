export type CaptureMode = 'region' | 'window' | 'fullscreen' | 'scroll' | 'webpage' | 'delay'
export type Platform = 'aix' | 'darwin' | 'freebsd' | 'linux' | 'openbsd' | 'sunos' | 'win32' | 'android' | 'haiku' | 'cygwin' | 'netbsd'

export type ImageFormat = 'png' | 'jpeg' | 'webp'
export type AfterCaptureAction = 'editor' | 'clipboard' | 'save'
export type ThemePreference = 'system' | 'light' | 'dark'

export type ShortcutAction =
  | 'captureRegion'
  | 'captureWindow'
  | 'captureFullscreen'
  | 'captureScroll'
  | 'captureDelay'
  | 'repeatLastRegion'
  | 'openHistory'
  | 'openDashboard'
  | 'stopScrollCapture'

export interface ShortcutDefinition {
  action: ShortcutAction
  label: string
  accelerator: string
  registered: boolean
  error?: string
}

export interface AppSettings {
  saveDirectory: string
  fileNameTemplate: string
  imageFormat: ImageFormat
  jpegQuality: number
  afterCapture: AfterCaptureAction
  copyAfterSave: boolean
  showNotifications: boolean
  launchAtLogin: boolean
  keepInTray: boolean
  historyLimit: number
  scrollIntervalMs: number
  scrollMaxFrames: number
  scrollOverlapThreshold: number
  theme: ThemePreference
  shortcuts: Record<ShortcutAction, string>
}

export interface Point {
  x: number
  y: number
}

export interface CaptureRect extends Point {
  width: number
  height: number
}

export interface DisplaySnapshot {
  displayId: string
  dataUrl: string
  bounds: CaptureRect
  scaleFactor: number
  imageWidth: number
  imageHeight: number
}

export interface DesktopSourcePreview {
  id: string
  name: string
  kind: 'screen' | 'window'
  displayId?: string
  appIconDataUrl?: string
  thumbnailDataUrl: string
  width: number
  height: number
}

export interface CaptureRequest {
  mode: CaptureMode
  sourceId?: string
  delaySeconds?: number
  url?: string
}

export interface CaptureAsset {
  id: string
  mode: CaptureMode
  createdAt: string
  width: number
  height: number
  dataUrl: string
  filePath?: string
  sourceName?: string
  frameCount?: number
  warnings?: string[]
}

export interface HistoryItem extends Omit<CaptureAsset, 'dataUrl'> {
  thumbnailDataUrl: string
}

export interface SaveRequest {
  dataUrl: string
  suggestedName?: string
  format?: ImageFormat
  chooseLocation?: boolean
}

export interface SaveResult {
  canceled: boolean
  filePath?: string
}

export interface ScrollCaptureProgress {
  state: 'selecting' | 'capturing' | 'stitching' | 'completed' | 'canceled' | 'error'
  frameCount: number
  uniqueFrameCount: number
  message: string
  error?: string
}

export interface OverlaySelectionResult {
  canceled: boolean
  rect?: CaptureRect
  displayId: string
}

export type AnnotationTool =
  | 'select'
  | 'crop'
  | 'rectangle'
  | 'ellipse'
  | 'arrow'
  | 'line'
  | 'pen'
  | 'highlighter'
  | 'text'
  | 'mosaic'
  | 'blur'
  | 'number'
  | 'color-picker'

interface AnnotationBase {
  id: string
  tool: AnnotationTool
  color: string
  strokeWidth: number
}

export interface BoundsAnnotation extends AnnotationBase {
  tool: 'rectangle' | 'ellipse' | 'mosaic' | 'blur' | 'crop'
  start: Point
  end: Point
}

export interface LineAnnotation extends AnnotationBase {
  tool: 'arrow' | 'line'
  start: Point
  end: Point
}

export interface PathAnnotation extends AnnotationBase {
  tool: 'pen' | 'highlighter'
  points: Point[]
}

export interface TextAnnotation extends AnnotationBase {
  tool: 'text'
  point: Point
  text: string
  fontSize: number
}

export interface NumberAnnotation extends AnnotationBase {
  tool: 'number'
  point: Point
  value: number
}

export type Annotation = BoundsAnnotation | LineAnnotation | PathAnnotation | TextAnnotation | NumberAnnotation

export interface PermissionState {
  platform: Platform
  screen: 'granted' | 'denied' | 'restricted' | 'unknown' | 'not-needed'
  canRequest: boolean
}

export interface BrclioShotApi {
  platform: Platform
  getSettings: () => Promise<AppSettings>
  updateSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>
  chooseSaveDirectory: () => Promise<string | null>
  getPermissionState: () => Promise<PermissionState>
  requestScreenPermission: () => Promise<PermissionState>
  listDesktopSources: (kind: 'screen' | 'window') => Promise<DesktopSourcePreview[]>
  capture: (request: CaptureRequest) => Promise<CaptureAsset | null>
  startScrollCapture: () => Promise<void>
  stopScrollCapture: () => Promise<CaptureAsset | null>
  cancelScrollCapture: () => Promise<void>
  save: (request: SaveRequest) => Promise<SaveResult>
  copyImage: (dataUrl: string) => Promise<void>
  pinImage: (dataUrl: string) => Promise<void>
  pinReady: () => void
  setPinOpacity: (opacity: number) => Promise<void>
  closeCurrentWindow: () => Promise<void>
  getHistory: () => Promise<HistoryItem[]>
  openHistoryItem: (id: string) => Promise<CaptureAsset | null>
  deleteHistoryItem: (id: string) => Promise<void>
  clearHistory: () => Promise<void>
  revealFile: (filePath: string) => Promise<void>
  overlayReady: () => void
  completeOverlay: (result: OverlaySelectionResult) => void
  cancelOverlay: () => void
  onOverlayInit: (listener: (snapshot: DisplaySnapshot) => void) => () => void
  onCaptureResult: (listener: (asset: CaptureAsset) => void) => () => void
  onScrollProgress: (listener: (progress: ScrollCaptureProgress) => void) => () => void
  onSettingsChanged: (listener: (settings: AppSettings) => void) => () => void
  onShortcutStatus: (listener: (shortcuts: ShortcutDefinition[]) => void) => () => void
  onPinInit: (listener: (dataUrl: string) => void) => () => void
  onNavigate: (listener: (section: 'capture' | 'history' | 'settings') => void) => () => void
  onCaptureCountdown: (listener: (seconds: number) => void) => () => void
}

export interface CaptureRuntimeFrame {
  requestId: string
  dataUrl: string
  width: number
  height: number
}

export interface CaptureRuntimeApi {
  rendererReady: () => void
  ready: (size: { width: number; height: number }) => void
  frame: (frame: CaptureRuntimeFrame) => void
  error: (message: string) => void
  stopped: () => void
  onStart: (listener: () => void) => () => void
  onGrab: (listener: (requestId: string) => void) => () => void
  onStop: (listener: () => void) => () => void
}

export const IPC_CHANNELS = {
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  settingsChooseDirectory: 'settings:choose-directory',
  permissionGet: 'permission:get',
  permissionRequest: 'permission:request',
  sourcesList: 'sources:list',
  captureStart: 'capture:start',
  scrollStart: 'scroll:start',
  scrollStop: 'scroll:stop',
  scrollCancel: 'scroll:cancel',
  imageSave: 'image:save',
  imageCopy: 'image:copy',
  imagePin: 'image:pin',
  pinReady: 'pin:ready',
  pinSetOpacity: 'pin:set-opacity',
  windowCloseCurrent: 'window:close-current',
  historyGet: 'history:get',
  historyOpen: 'history:open',
  historyDelete: 'history:delete',
  historyClear: 'history:clear',
  fileReveal: 'file:reveal',
  overlayReady: 'overlay:ready',
  overlayInit: 'overlay:init',
  overlayComplete: 'overlay:complete',
  overlayCancel: 'overlay:cancel',
  captureResult: 'capture:result',
  scrollProgress: 'scroll:progress',
  settingsChanged: 'settings:changed',
  shortcutStatus: 'shortcut:status',
  pinInit: 'pin:init',
  runtimeStart: 'runtime:start',
  runtimeRendererReady: 'runtime:renderer-ready',
  runtimeGrab: 'runtime:grab',
  runtimeStop: 'runtime:stop',
  runtimeReady: 'runtime:ready',
  runtimeFrame: 'runtime:frame',
  runtimeError: 'runtime:error',
  runtimeStopped: 'runtime:stopped',
  navigationOpen: 'navigation:open',
  captureCountdown: 'capture:countdown'
} as const
