import { randomUUID } from 'node:crypto'
import { BrowserWindow, type Rectangle } from 'electron'
import sharp from 'sharp'

export interface WebpageCaptureResult {
  buffer: Buffer
  width: number
  height: number
  title: string
  warnings: string[]
}
interface LayoutMetrics {
  cssContentSize: { width: number; height: number }
}

interface ScreenshotResponse {
  data: string
}

const MAX_WIDTH = 8_192
const MAX_HEIGHT = 100_000
const MAX_PIXELS = 200_000_000
const TILE_HEIGHT = 7_500

function normalizeUrl(value: string): URL {
  const withProtocol = /^[a-z][a-z\d+.-]*:/i.test(value.trim()) ? value.trim() : `https://${value.trim()}`
  const url = new URL(withProtocol)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('网页整页截图仅支持 HTTP 或 HTTPS 地址')
  return url
}

async function waitForLoad(window: BrowserWindow, url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('网页加载超过 30 秒')), 30_000)
    const cleanup = (): void => {
      clearTimeout(timer)
      window.webContents.removeListener('did-finish-load', onFinish)
      window.webContents.removeListener('did-fail-load', onFail)
    }
    const onFinish = (): void => {
      cleanup()
      resolve()
    }
    const onFail = (_event: Electron.Event, code: number, description: string): void => {
      cleanup()
      reject(new Error(`网页加载失败（${code}）：${description}`))
    }
    window.webContents.once('did-finish-load', onFinish)
    window.webContents.once('did-fail-load', onFail)
    void window.loadURL(url).catch((error) => {
      cleanup()
      reject(error)
    })
  })
}

async function triggerLazyContent(window: BrowserWindow): Promise<void> {
  await window.webContents
    .executeJavaScript(`
      new Promise((resolve) => {
        const started = Date.now();
        const maxDuration = 12000;
        const step = Math.max(400, Math.floor(window.innerHeight * 0.8));
        let lastHeight = 0;
        let stableTicks = 0;
        const timer = setInterval(() => {
          const height = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);
          window.scrollBy(0, step);
          if (height === lastHeight && window.scrollY + window.innerHeight >= height - 4) stableTicks += 1;
          else stableTicks = 0;
          lastHeight = height;
          if (stableTicks >= 3 || Date.now() - started >= maxDuration || height > 100000) {
            clearInterval(timer);
            window.scrollTo(0, 0);
            setTimeout(resolve, 500);
          }
        }, 180);
      })
    `)
    .catch(() => undefined)
}

export async function captureWebpage(inputUrl: string): Promise<WebpageCaptureResult> {
  const url = normalizeUrl(inputUrl)
  const captureWindow = new BrowserWindow({
    show: false,
    width: 1440,
    height: 900,
    backgroundColor: '#f7f3e9',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      partition: `brclio-shot-web-${randomUUID()}`
    }
  })
  const isolatedSession = captureWindow.webContents.session
  isolatedSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  isolatedSession.setPermissionCheckHandler(() => false)
  captureWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  captureWindow.webContents.session.on('will-download', (event) => event.preventDefault())

  try {
    await waitForLoad(captureWindow, url.toString())
    await triggerLazyContent(captureWindow)
    captureWindow.webContents.debugger.attach('1.3')
    await captureWindow.webContents.debugger.sendCommand('Page.enable')
    const metrics = (await captureWindow.webContents.debugger.sendCommand('Page.getLayoutMetrics')) as LayoutMetrics
    const width = Math.ceil(metrics.cssContentSize.width)
    const height = Math.ceil(metrics.cssContentSize.height)
    if (width < 1 || height < 1) throw new Error('网页没有可捕获的内容尺寸')
    if (width > MAX_WIDTH || height > MAX_HEIGHT || width * height > MAX_PIXELS) {
      throw new Error(`网页尺寸 ${width}×${height} 超过长图安全上限`)
    }

    const tiles: Buffer[] = []
    for (let y = 0; y < height; y += TILE_HEIGHT) {
      const tileHeight = Math.min(TILE_HEIGHT, height - y)
      const response = (await captureWindow.webContents.debugger.sendCommand('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: true,
        clip: { x: 0, y, width, height: tileHeight, scale: 1 }
      })) as ScreenshotResponse
      tiles.push(Buffer.from(response.data, 'base64'))
    }

    const buffer =
      tiles.length === 1
        ? tiles[0]
        : await sharp(tiles, { join: { across: 1, shim: 0, background: '#f7f3e9' }, limitInputPixels: MAX_PIXELS })
            .png({ compressionLevel: 6 })
            .toBuffer()
    return {
      buffer,
      width,
      height,
      title: captureWindow.getTitle() || url.hostname,
      warnings: [
        '网页整页截图使用隔离会话；需要登录态的页面请改用手动滚动长截图。',
        '无限滚动、视频与跨域画布可能无法像素级还原。'
      ]
    }
  } finally {
    if (captureWindow.webContents.debugger.isAttached()) captureWindow.webContents.debugger.detach()
    captureWindow.destroy()
  }
}

export function clampWindowBounds(bounds: Rectangle): Rectangle {
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height))
  }
}
