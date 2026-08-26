import { mkdir, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import type { CaptureAsset, HistoryItem } from '../shared/types'
import { decodeImageDataUrl } from './save-service'

interface StoredHistoryItem extends Omit<CaptureAsset, 'dataUrl'> {
  imagePath: string
  thumbnailPath: string
}

export class HistoryStore {
  private readonly root: string
  private readonly indexPath: string
  private items: StoredHistoryItem[] = []

  constructor(userDataPath: string) {
    this.root = join(userDataPath, 'history')
    this.indexPath = join(this.root, 'index.json')
  }

  async load(): Promise<void> {
    await mkdir(this.root, { recursive: true })
    try {
      const parsed = JSON.parse(await readFile(this.indexPath, 'utf8')) as StoredHistoryItem[]
      this.items = Array.isArray(parsed) ? parsed : []
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
      this.items = []
    }
  }

  async add(asset: CaptureAsset, limit: number): Promise<void> {
    if (limit <= 0) return
    const input = decodeImageDataUrl(asset.dataUrl)
    const imagePath = join(this.root, `${asset.id}.png`)
    const thumbnailPath = join(this.root, `${asset.id}.thumb.jpg`)
    const normalized = await sharp(input, { limitInputPixels: 220_000_000 }).png().toBuffer()
    const thumbnail = await sharp(input, { limitInputPixels: 220_000_000 })
      .resize({ width: 420, height: 260, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#f7f3e9' })
      .jpeg({ quality: 76 })
      .toBuffer()
    await Promise.all([writeFile(imagePath, normalized), writeFile(thumbnailPath, thumbnail)])
    const { dataUrl: _dataUrl, ...metadata } = asset
    this.items.unshift({ ...metadata, imagePath, thumbnailPath })
    this.items = this.items.filter((item, index, all) => all.findIndex((entry) => entry.id === item.id) === index)

    const removed = this.items.splice(limit)
    await Promise.all(removed.flatMap((item) => [unlink(item.imagePath).catch(() => undefined), unlink(item.thumbnailPath).catch(() => undefined)]))
    await this.persist()
  }

  async list(): Promise<HistoryItem[]> {
    const results: HistoryItem[] = []
    for (const item of this.items) {
      try {
        const thumbnail = await readFile(item.thumbnailPath)
        const { imagePath: _imagePath, thumbnailPath: _thumbnailPath, ...metadata } = item
        results.push({ ...metadata, thumbnailDataUrl: `data:image/jpeg;base64,${thumbnail.toString('base64')}` })
      } catch {
        // Ignore entries whose files were removed outside Brclio Shot.
      }
    }
    return results
  }

  async open(id: string): Promise<CaptureAsset | null> {
    const item = this.items.find((entry) => entry.id === id)
    if (!item) return null
    try {
      const image = await readFile(item.imagePath)
      const { imagePath: _imagePath, thumbnailPath: _thumbnailPath, ...metadata } = item
      return { ...metadata, dataUrl: `data:image/png;base64,${image.toString('base64')}` }
    } catch {
      return null
    }
  }

  async delete(id: string): Promise<void> {
    const item = this.items.find((entry) => entry.id === id)
    this.items = this.items.filter((entry) => entry.id !== id)
    if (item) await Promise.all([unlink(item.imagePath).catch(() => undefined), unlink(item.thumbnailPath).catch(() => undefined)])
    await this.persist()
  }

  async clear(): Promise<void> {
    const names = await readdir(this.root).catch(() => [])
    await Promise.all(names.filter((name) => name !== 'index.json').map((name) => rm(join(this.root, name), { force: true })))
    this.items = []
    await this.persist()
  }

  private async persist(): Promise<void> {
    const temporaryPath = `${this.indexPath}.tmp-${process.pid}`
    await writeFile(temporaryPath, `${JSON.stringify(this.items, null, 2)}\n`, { mode: 0o600 })
    await rename(temporaryPath, this.indexPath)
  }
}
