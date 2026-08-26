import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AppSettings, ShortcutAction } from '../shared/types'

const SETTINGS_VERSION = 1

interface PersistedSettings {
  version: number
  settings: AppSettings
}
const SHORTCUT_ACTIONS: ShortcutAction[] = [
  'captureRegion',
  'captureWindow',
  'captureFullscreen',
  'captureScroll',
  'captureDelay',
  'repeatLastRegion',
  'openHistory',
  'openDashboard',
  'stopScrollCapture'
]

export function defaultShortcuts(platform: NodeJS.Platform): AppSettings['shortcuts'] {
  const prefix = platform === 'darwin' ? 'Alt+Shift' : 'CommandOrControl+Shift'

  return {
    openDashboard: `${prefix}+S`,
    captureRegion: `${prefix}+A`,
    captureWindow: `${prefix}+W`,
    captureFullscreen: `${prefix}+F`,
    captureScroll: `${prefix}+L`,
    captureDelay: `${prefix}+D`,
    repeatLastRegion: `${prefix}+R`,
    openHistory: `${prefix}+H`,
    stopScrollCapture: 'CommandOrControl+Shift+Enter'
  }
}

export function createDefaultSettings(picturesPath: string, platform: NodeJS.Platform): AppSettings {
  return {
    saveDirectory: join(picturesPath, 'Brclio Shot'),
    fileNameTemplate: 'Brclio Shot {date} {time}',
    imageFormat: 'png',
    jpegQuality: 92,
    afterCapture: 'editor',
    copyAfterSave: false,
    showNotifications: true,
    launchAtLogin: false,
    keepInTray: true,
    historyLimit: 100,
    scrollIntervalMs: 650,
    scrollMaxFrames: 80,
    scrollOverlapThreshold: 0.72,
    theme: 'system',
    shortcuts: defaultShortcuts(platform)
  }
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}

function normalizeSettings(candidate: unknown, defaults: AppSettings): AppSettings {
  if (!candidate || typeof candidate !== 'object') return defaults
  const input = candidate as Partial<AppSettings>
  const shortcuts = { ...defaults.shortcuts }

  if (input.shortcuts && typeof input.shortcuts === 'object') {
    for (const action of SHORTCUT_ACTIONS) {
      const accelerator = input.shortcuts[action]
      if (typeof accelerator === 'string' && accelerator.trim().length > 0 && accelerator.length <= 80) {
        shortcuts[action] = accelerator.trim()
      }
    }
  }

  return {
    saveDirectory:
      typeof input.saveDirectory === 'string' && input.saveDirectory.trim().length > 0
        ? input.saveDirectory.trim()
        : defaults.saveDirectory,
    fileNameTemplate:
      typeof input.fileNameTemplate === 'string' && input.fileNameTemplate.trim().length > 0
        ? input.fileNameTemplate.trim().slice(0, 180)
        : defaults.fileNameTemplate,
    imageFormat: ['png', 'jpeg', 'webp'].includes(input.imageFormat ?? '')
      ? (input.imageFormat as AppSettings['imageFormat'])
      : defaults.imageFormat,
    jpegQuality: boundedNumber(input.jpegQuality, defaults.jpegQuality, 40, 100),
    afterCapture: ['editor', 'clipboard', 'save'].includes(input.afterCapture ?? '')
      ? (input.afterCapture as AppSettings['afterCapture'])
      : defaults.afterCapture,
    copyAfterSave: typeof input.copyAfterSave === 'boolean' ? input.copyAfterSave : defaults.copyAfterSave,
    showNotifications:
      typeof input.showNotifications === 'boolean' ? input.showNotifications : defaults.showNotifications,
    launchAtLogin: typeof input.launchAtLogin === 'boolean' ? input.launchAtLogin : defaults.launchAtLogin,
    keepInTray: typeof input.keepInTray === 'boolean' ? input.keepInTray : defaults.keepInTray,
    historyLimit: Math.round(boundedNumber(input.historyLimit, defaults.historyLimit, 0, 500)),
    scrollIntervalMs: Math.round(boundedNumber(input.scrollIntervalMs, defaults.scrollIntervalMs, 250, 2500)),
    scrollMaxFrames: Math.round(boundedNumber(input.scrollMaxFrames, defaults.scrollMaxFrames, 2, 160)),
    scrollOverlapThreshold: boundedNumber(
      input.scrollOverlapThreshold,
      defaults.scrollOverlapThreshold,
      0.45,
      0.98
    ),
    theme: ['system', 'light', 'dark'].includes(input.theme ?? '')
      ? (input.theme as AppSettings['theme'])
      : defaults.theme,
    shortcuts
  }
}

export class SettingsStore {
  private readonly filePath: string
  private readonly defaults: AppSettings
  private current: AppSettings

  constructor(userDataPath: string, picturesPath: string, platform: NodeJS.Platform = process.platform) {
    this.filePath = join(userDataPath, 'settings.json')
    this.defaults = createDefaultSettings(picturesPath, platform)
    this.current = this.defaults
  }

  async load(): Promise<AppSettings> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<PersistedSettings>
      this.current = normalizeSettings(parsed.settings, this.defaults)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
      this.current = this.defaults
    }

    await mkdir(this.current.saveDirectory, { recursive: true })
    return this.get()
  }

  get(): AppSettings {
    return structuredClone(this.current)
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    const next = normalizeSettings(
      {
        ...this.current,
        ...patch,
        shortcuts: patch.shortcuts ? { ...this.current.shortcuts, ...patch.shortcuts } : this.current.shortcuts
      },
      this.defaults
    )

    const normalizedAccelerators = Object.entries(next.shortcuts).map(([action, accelerator]) => [
      action,
      accelerator.toLowerCase().replaceAll(' ', '')
    ])
    const duplicates = normalizedAccelerators.filter(
      ([, accelerator], index, all) => all.findIndex(([, other]) => other === accelerator) !== index
    )
    if (duplicates.length > 0) {
      throw new Error(`快捷键重复：${duplicates.map(([action]) => action).join('、')}`)
    }

    await mkdir(next.saveDirectory, { recursive: true })
    this.current = next
    await this.persist()
    return this.get()
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.tmp-${process.pid}`
    const payload: PersistedSettings = { version: SETTINGS_VERSION, settings: this.current }
    await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporaryPath, this.filePath)
  }
}
