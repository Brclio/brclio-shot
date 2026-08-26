import { globalShortcut } from 'electron'
import type { AppSettings, ShortcutAction, ShortcutDefinition } from '../shared/types'

const LABELS: Record<ShortcutAction, string> = {
  openDashboard: '打开截图面板',
  captureRegion: '区域截图',
  captureWindow: '窗口截图',
  captureFullscreen: '全屏截图',
  captureScroll: '长截图',
  captureDelay: '延时截图',
  repeatLastRegion: '重复上一区域',
  openHistory: '截图历史',
  stopScrollCapture: '结束长截图'
}
export type ShortcutHandlers = Record<ShortcutAction, () => void | Promise<void>>

export class ShortcutRegistry {
  private lastStatus: ShortcutDefinition[] = []

  register(settings: AppSettings, handlers: ShortcutHandlers): ShortcutDefinition[] {
    globalShortcut.unregisterAll()
    const seen = new Set<string>()
    this.lastStatus = (Object.entries(settings.shortcuts) as [ShortcutAction, string][]).map(([action, accelerator]) => {
      const normalized = accelerator.toLowerCase().replaceAll(' ', '')
      if (seen.has(normalized)) {
        return { action, label: LABELS[action], accelerator, registered: false, error: '与另一个 Brclio Shot 快捷键重复' }
      }
      seen.add(normalized)

      try {
        const registered = globalShortcut.register(accelerator, () => void handlers[action]())
        return {
          action,
          label: LABELS[action],
          accelerator,
          registered,
          error: registered ? undefined : '被系统或其他应用占用'
        }
      } catch (error) {
        return {
          action,
          label: LABELS[action],
          accelerator,
          registered: false,
          error: error instanceof Error ? error.message : '快捷键格式无效'
        }
      }
    })
    return this.status()
  }

  status(): ShortcutDefinition[] {
    return structuredClone(this.lastStatus)
  }

  unregisterAll(): void {
    globalShortcut.unregisterAll()
    this.lastStatus = []
  }
}
