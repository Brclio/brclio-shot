import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { rm } from 'node:fs/promises'
import { SettingsStore, createDefaultSettings, defaultShortcuts } from '../../src/main/settings-store'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'brclio-shot-settings-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})
describe('settings store', () => {
  it('uses system Pictures and platform-safe shortcuts by default', () => {
    const mac = createDefaultSettings('/Pictures', 'darwin')
    const windows = createDefaultSettings('C:\\Pictures', 'win32')

    expect(mac.saveDirectory).toBe(join('/Pictures', 'Brclio Shot'))
    expect(windows.saveDirectory).toBe(join('C:\\Pictures', 'Brclio Shot'))
    expect(mac.shortcuts.captureRegion).toBe('Alt+Shift+A')
    expect(windows.shortcuts.captureRegion).toBe('CommandOrControl+Shift+A')
    expect(new Set(Object.values(defaultShortcuts('darwin'))).size).toBe(9)
  })

  it('persists bounded settings atomically', async () => {
    const directory = await temporaryDirectory()
    const store = new SettingsStore(directory, join(directory, 'Pictures'), 'darwin')
    await store.load()
    const saved = await store.update({ jpegQuality: 120, scrollIntervalMs: 10, historyLimit: 999 })

    expect(saved.jpegQuality).toBe(100)
    expect(saved.scrollIntervalMs).toBe(250)
    expect(saved.historyLimit).toBe(500)
    const disk = JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8')) as { version: number }
    expect(disk.version).toBe(1)
  })

  it('recovers from malformed JSON with safe defaults', async () => {
    const directory = await temporaryDirectory()
    await writeFile(join(directory, 'settings.json'), '{not-json')
    const store = new SettingsStore(directory, join(directory, 'Pictures'), 'win32')

    const settings = await store.load()
    expect(settings.imageFormat).toBe('png')
    expect(settings.afterCapture).toBe('editor')
  })

  it('rejects duplicate accelerators', async () => {
    const directory = await temporaryDirectory()
    const store = new SettingsStore(directory, join(directory, 'Pictures'), 'darwin')
    const settings = await store.load()

    await expect(
      store.update({ shortcuts: { ...settings.shortcuts, captureWindow: settings.shortcuts.captureRegion } })
    ).rejects.toThrow('快捷键重复')
  })
})
