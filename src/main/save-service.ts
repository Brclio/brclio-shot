import { copyFile, link, mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { dialog, type BrowserWindow } from 'electron'
import sharp from 'sharp'
import type { AppSettings, CaptureMode, ImageFormat, SaveRequest, SaveResult } from '../shared/types'

const MAX_INPUT_BYTES = 500 * 1024 * 1024

export function decodeImageDataUrl(dataUrl: string): Buffer {
  const match = /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(dataUrl)
  if (!match) throw new Error('图片数据格式无效')
  const buffer = Buffer.from(match[2], 'base64')
  if (buffer.byteLength === 0 || buffer.byteLength > MAX_INPUT_BYTES) throw new Error('图片数据为空或超过 500 MB 限制')
  return buffer
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0')
}

function modeLabel(mode: CaptureMode | undefined): string {
  const labels: Record<CaptureMode, string> = {
    region: '区域',
    window: '窗口',
    fullscreen: '全屏',
    scroll: '长截图',
    webpage: '网页整页',
    delay: '延时'
  }
  return mode ? labels[mode] : '截图'
}

export function sanitizeFileName(value: string): string {
  const sanitized = value
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/[. ]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const windowsReserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i
  return (windowsReserved.test(sanitized) ? `_${sanitized}` : sanitized || 'Brclio Shot').slice(0, 180)
}

export function renderFileName(template: string, mode?: CaptureMode, now = new Date()): string {
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const time = `${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`
  return sanitizeFileName(
    template
      .replaceAll('{date}', date)
      .replaceAll('{time}', time)
      .replaceAll('{mode}', modeLabel(mode))
      .replaceAll('{timestamp}', String(now.getTime()))
  )
}

function extensionFor(format: ImageFormat): string {
  return format === 'jpeg' ? 'jpg' : format
}

async function encodeImage(input: Buffer, format: ImageFormat, quality: number): Promise<Buffer> {
  const pipeline = sharp(input, { failOn: 'error', limitInputPixels: 220_000_000 }).rotate()
  if (format === 'jpeg') return pipeline.flatten({ background: '#f7f3e9' }).jpeg({ quality, mozjpeg: true }).toBuffer()
  if (format === 'webp') return pipeline.webp({ quality, effort: 4 }).toBuffer()
  return pipeline.png({ compressionLevel: 6, adaptiveFiltering: true }).toBuffer()
}

async function writeAtomically(targetPath: string, data: Buffer, allowOverwrite: boolean): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true })
  const temporaryPath = join(dirname(targetPath), `.${basename(targetPath)}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporaryPath, data, { flag: 'wx', mode: 0o600 })
    if (allowOverwrite) {
      await rename(temporaryPath, targetPath)
    } else {
      try {
        await link(temporaryPath, targetPath)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'EPERM' || code === 'EXDEV' || code === 'ENOTSUP') {
          await copyFile(temporaryPath, targetPath, constants.COPYFILE_EXCL)
        } else {
          throw error
        }
      }
      await unlink(temporaryPath)
    }
  } catch (error) {
    try {
      await unlink(temporaryPath)
    } catch {
      // The temporary file may not have been created.
    }
    throw error
  }
}

async function availablePath(directory: string, stem: string, extension: string): Promise<string> {
  const { access } = await import('node:fs/promises')
  for (let counter = 1; counter <= 10_000; counter += 1) {
    const suffix = counter === 1 ? '' : `-${counter}`
    const candidate = join(directory, `${stem}${suffix}.${extension}`)
    try {
      await access(candidate)
    } catch {
      return candidate
    }
  }
  throw new Error('无法生成不重复的文件名')
}

export class SaveService {
  async save(
    request: SaveRequest,
    settings: AppSettings,
    owner: BrowserWindow | null,
    mode?: CaptureMode
  ): Promise<SaveResult> {
    const format = request.format ?? settings.imageFormat
    const extension = extensionFor(format)
    const requestExtension = request.suggestedName ? extname(request.suggestedName) : ''
    const requestedStem = request.suggestedName
      ? sanitizeFileName(requestExtension ? request.suggestedName.slice(0, -requestExtension.length) : request.suggestedName)
      : renderFileName(settings.fileNameTemplate, mode)
    const input = decodeImageDataUrl(request.dataUrl)
    const encoded = await encodeImage(input, format, settings.jpegQuality)

    let targetPath: string
    if (request.chooseLocation) {
      const defaultPath = join(settings.saveDirectory, `${requestedStem}.${extension}`)
      const result = owner
        ? await dialog.showSaveDialog(owner, {
            title: '保存截图',
            defaultPath,
            filters: [{ name: format.toUpperCase(), extensions: [extension] }]
          })
        : await dialog.showSaveDialog({
            title: '保存截图',
            defaultPath,
            filters: [{ name: format.toUpperCase(), extensions: [extension] }]
          })
      if (result.canceled || !result.filePath) return { canceled: true }
      targetPath = result.filePath.endsWith(`.${extension}`) ? result.filePath : `${result.filePath}.${extension}`
    } else {
      targetPath = await availablePath(settings.saveDirectory, requestedStem, extension)
    }

    await writeAtomically(targetPath, encoded, Boolean(request.chooseLocation))
    return { canceled: false, filePath: targetPath }
  }
}
