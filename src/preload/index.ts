import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppSettings,
  BrclioShotApi,
  CaptureAsset,
  CaptureRuntimeApi,
  CaptureRuntimeFrame,
  CaptureRequest,
  DesktopSourcePreview,
  DisplaySnapshot,
  HistoryItem,
  OverlaySelectionResult,
  PermissionState,
  SaveRequest,
  SaveResult,
  ScrollCaptureProgress,
  ShortcutDefinition
} from '../shared/types'
import { IPC_CHANNELS } from '../shared/types'

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (_event: Electron.IpcRendererEvent, payload: T): void => listener(payload)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

const api: BrclioShotApi = {
  platform: process.platform,
  getSettings: () => ipcRenderer.invoke(IPC_CHANNELS.settingsGet) as Promise<AppSettings>,
  updateSettings: (patch) => ipcRenderer.invoke(IPC_CHANNELS.settingsUpdate, patch) as Promise<AppSettings>,
  chooseSaveDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.settingsChooseDirectory) as Promise<string | null>,
  getPermissionState: () => ipcRenderer.invoke(IPC_CHANNELS.permissionGet) as Promise<PermissionState>,
  requestScreenPermission: () => ipcRenderer.invoke(IPC_CHANNELS.permissionRequest) as Promise<PermissionState>,
  listDesktopSources: (kind) => ipcRenderer.invoke(IPC_CHANNELS.sourcesList, kind) as Promise<DesktopSourcePreview[]>,
  capture: (request: CaptureRequest) => ipcRenderer.invoke(IPC_CHANNELS.captureStart, request) as Promise<CaptureAsset | null>,
  startScrollCapture: () => ipcRenderer.invoke(IPC_CHANNELS.scrollStart) as Promise<void>,
  stopScrollCapture: () => ipcRenderer.invoke(IPC_CHANNELS.scrollStop) as Promise<CaptureAsset | null>,
  cancelScrollCapture: () => ipcRenderer.invoke(IPC_CHANNELS.scrollCancel) as Promise<void>,
  save: (request: SaveRequest) => ipcRenderer.invoke(IPC_CHANNELS.imageSave, request) as Promise<SaveResult>,
  copyImage: (dataUrl: string) => ipcRenderer.invoke(IPC_CHANNELS.imageCopy, dataUrl) as Promise<void>,
  pinImage: (dataUrl: string) => ipcRenderer.invoke(IPC_CHANNELS.imagePin, dataUrl) as Promise<void>,
  pinReady: () => ipcRenderer.send(IPC_CHANNELS.pinReady),
  setPinOpacity: (opacity: number) => ipcRenderer.invoke(IPC_CHANNELS.pinSetOpacity, opacity) as Promise<void>,
  closeCurrentWindow: () => ipcRenderer.invoke(IPC_CHANNELS.windowCloseCurrent) as Promise<void>,
  getHistory: () => ipcRenderer.invoke(IPC_CHANNELS.historyGet) as Promise<HistoryItem[]>,
  openHistoryItem: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.historyOpen, id) as Promise<CaptureAsset | null>,
  deleteHistoryItem: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.historyDelete, id) as Promise<void>,
  clearHistory: () => ipcRenderer.invoke(IPC_CHANNELS.historyClear) as Promise<void>,
  revealFile: (filePath: string) => ipcRenderer.invoke(IPC_CHANNELS.fileReveal, filePath) as Promise<void>,
  overlayReady: () => ipcRenderer.send(IPC_CHANNELS.overlayReady),
  completeOverlay: (result: OverlaySelectionResult) => ipcRenderer.send(IPC_CHANNELS.overlayComplete, result),
  cancelOverlay: () => ipcRenderer.send(IPC_CHANNELS.overlayCancel),
  onOverlayInit: (listener: (snapshot: DisplaySnapshot) => void) => subscribe(IPC_CHANNELS.overlayInit, listener),
  onCaptureResult: (listener: (asset: CaptureAsset) => void) => subscribe(IPC_CHANNELS.captureResult, listener),
  onScrollProgress: (listener: (progress: ScrollCaptureProgress) => void) => subscribe(IPC_CHANNELS.scrollProgress, listener),
  onSettingsChanged: (listener: (settings: AppSettings) => void) => subscribe(IPC_CHANNELS.settingsChanged, listener),
  onShortcutStatus: (listener: (shortcuts: ShortcutDefinition[]) => void) => subscribe(IPC_CHANNELS.shortcutStatus, listener),
  onPinInit: (listener: (dataUrl: string) => void) => subscribe(IPC_CHANNELS.pinInit, listener),
  onNavigate: (listener: (section: 'capture' | 'history' | 'settings') => void) => subscribe(IPC_CHANNELS.navigationOpen, listener),
  onCaptureCountdown: (listener: (seconds: number) => void) => subscribe(IPC_CHANNELS.captureCountdown, listener)
}

contextBridge.exposeInMainWorld('brclioShot', api)

const runtimeApi: CaptureRuntimeApi = {
  rendererReady: () => ipcRenderer.send(IPC_CHANNELS.runtimeRendererReady),
  ready: (size) => ipcRenderer.send(IPC_CHANNELS.runtimeReady, size),
  frame: (frame: CaptureRuntimeFrame) => ipcRenderer.send(IPC_CHANNELS.runtimeFrame, frame),
  error: (message: string) => ipcRenderer.send(IPC_CHANNELS.runtimeError, message),
  stopped: () => ipcRenderer.send(IPC_CHANNELS.runtimeStopped),
  onStart: (listener) => subscribe(IPC_CHANNELS.runtimeStart, listener),
  onGrab: (listener) => subscribe(IPC_CHANNELS.runtimeGrab, listener),
  onStop: (listener) => subscribe(IPC_CHANNELS.runtimeStop, listener)
}

contextBridge.exposeInMainWorld('brclioRuntime', runtimeApi)
